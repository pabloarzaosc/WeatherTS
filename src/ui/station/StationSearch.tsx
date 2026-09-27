import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, X } from "lucide-react";

import {
  distanceMi,
  fetchStationDirectory,
  lookupStation,
  searchStations,
  type StationInfo,
} from "../../lib/stations";
import { getMap, subscribeMaps } from "../../map/mapInstance";
import { useStationStore } from "../../store/useStationStore";

/**
 * Finding a station, by name or by where the map is looking.
 *
 * The whole directory is held in the client, so typing filters 2,600 sites
 * without a round trip; with the box empty it lists what is under the current
 * view instead, which is the other way people reach for a station.
 */
export function StationSearch() {
  const [list, setList] = useState<StationInfo[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [centre, setCentre] = useState<[number, number] | null>(null);

  const open = useStationStore((s) => s.open);
  const recent = useStationStore((s) => s.recent);
  const openId = useStationStore((s) => s.station?.info?.icao ?? s.station?.id ?? null);

  useEffect(() => {
    let cancelled = false;
    fetchStationDirectory()
      .then((rows) => {
        if (cancelled) return;
        setList(rows);
        setBusy(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setBusy(false);
        setError(String(err instanceof Error ? err.message : err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Follow the map so "nearby" means near what the user is actually looking at.
  useEffect(() => {
    let map = getMap();
    const read = () => {
      const m = getMap();
      if (!m) return;
      const c = m.getCenter();
      setCentre([c.lat, c.lng]);
    };
    const attach = () => {
      map?.off("moveend", read);
      map = getMap();
      map?.on("moveend", read);
      read();
    };
    attach();
    const offMaps = subscribeMaps(attach);
    return () => {
      offMaps();
      map?.off("moveend", read);
    };
  }, []);

  const results = useMemo(() => (query.trim() ? searchStations(list, query, 30) : []), [list, query]);

  const nearby = useMemo(() => {
    if (query.trim() || !centre || !list.length) return [];
    return list
      .map((s) => ({ s, d: distanceMi(centre[0], centre[1], s.lat, s.lon) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 8)
      .map((o) => o.s);
  }, [list, centre, query]);

  const recents = useMemo(
    () =>
      query.trim()
        ? []
        : recent.map((id) => lookupStation(list, id)).filter((s): s is StationInfo => s != null).slice(0, 5),
    [recent, list, query],
  );

  const show = (s: StationInfo) => {
    open({ id: s.icao, name: s.name, lat: s.lat, lon: s.lon, info: s, current: {} });
  };

  const row = (s: StationInfo) => {
    const miles = centre ? distanceMi(centre[0], centre[1], s.lat, s.lon) : null;
    return (
      <button
        key={s.icao}
        type="button"
        className={`stsearch__row${openId === s.icao ? " is-on" : ""}`}
        onClick={() => show(s)}
      >
        <b>{s.icao}</b>
        <span>
          {s.name}
          {s.state ? `, ${s.state}` : ""}
        </span>
        {miles != null && <i>{miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi</i>}
      </button>
    );
  };

  return (
    <div className="stsearch">
      <div className="stsearch__field">
        <Search size={13} />
        <input
          type="search"
          value={query}
          placeholder={busy ? "Loading stations…" : "Station, city, county or state"}
          aria-label="Find a station"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results.length) show(results[0]);
            if (e.key === "Escape") setQuery("");
          }}
        />
        {busy && <Loader2 size={13} className="stsearch__spin" />}
        {!busy && query && (
          <button type="button" className="stsearch__clear" onClick={() => setQuery("")} aria-label="Clear">
            <X size={12} />
          </button>
        )}
      </div>

      {error && <div className="stsearch__note">Station list unavailable: {error}</div>}

      {query.trim() ? (
        <div className="stsearch__list">
          {results.length === 0 && !busy && <div className="stsearch__note">Nothing matches “{query}”.</div>}
          {results.map(row)}
        </div>
      ) : (
        <>
          {recents.length > 0 && (
            <>
              <div className="stsearch__head">Recent</div>
              <div className="stsearch__list">{recents.map(row)}</div>
            </>
          )}
          <div className="stsearch__head">
            In view
            {list.length ? <b>{list.length.toLocaleString()} stations</b> : null}
          </div>
          <div className="stsearch__list">
            {nearby.length === 0 && !busy && <div className="stsearch__note">Move the map to list stations.</div>}
            {nearby.map(row)}
          </div>
        </>
      )}
    </div>
  );
}
