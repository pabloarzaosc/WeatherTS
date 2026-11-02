import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { List, Search, X, Loader2, MapPin, RadioTower } from "lucide-react";

import { searchPlaces, type PlaceResult } from "../lib/photon";
import { getMap } from "../map/mapInstance";
import { placeOf, searchRadars } from "../lib/radarSites";
import { isBrazilSite } from "../lib/brazilRadar";
import { pickRadar, refreshSiteStatus } from "../lib/radarSitesInstall";
import { nearestRadar } from "../layers/radarHold";
import type { NexradSite } from "../lib/nexrad";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { siteClass, useRadarSitesStore } from "../store/useRadarSitesStore";

/** A place lands on the radar nearest it when the radar is on, within this range. */
const NEAREST_MAX_KM = 460;

type Item = { kind: "radar"; site: NexradSite } | { kind: "place"; place: PlaceResult };

export function SearchBar() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // The text a pick put in the box: it does not search (or open the list) again.
  const chosen = useRef<string | null>(null);
  const sites = useNexradStore((s) => s.sites);
  useRadarSitesStore((s) => s.feed);

  // Radars answer at once, from the site list: an id with or without its
  // first letter ("tlx" finds KTLX), a place name, a state (radar-sites).
  const radarHits = useMemo(() => searchRadars(sites, query, 5), [sites, query]);
  const items: Item[] = useMemo(
    () => [...radarHits.map((site) => ({ kind: "radar" as const, site })), ...results.map((place) => ({ kind: "place" as const, place }))],
    [radarHits, results],
  );

  useEffect(() => {
    if (radarHits.length && query !== chosen.current) {
      setOpen(true);
      setActive(0);
    }
  }, [radarHits]);

  // Debounced Photon query.
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    if (query === chosen.current) return;
    const controller = new AbortController();
    const handle = window.setTimeout(async () => {
      setLoading(true);
      try {
        const found = await searchPlaces(query, controller.signal);
        setResults(found);
        setActive(0);
        setOpen(true);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setResults([]);
      } finally {
        setLoading(false);
      }
    }, 280);
    return () => {
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [query]);

  // Close when clicking outside.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  function goTo(result: PlaceResult) {
    const map = getMap();
    map?.flyTo({
      center: [result.lng, result.lat],
      zoom: Math.max(map.getZoom(), 9),
      essential: true,
    });
    chosen.current = result.label;
    setQuery(result.label);
    setOpen(false);
    // With the radar on, the place gets the radar that sees it best.
    if (useAppStore.getState().layers.nexrad?.visible) {
      const near = nearestRadar(result.lat, result.lng);
      const nx = useNexradStore.getState();
      // (not a Brazilian radar kept as an archive volume: an old scan is no answer to a place)
      const oldVolume = !!near && isBrazilSite(near.site.id) && !near.site.live;
      if (near && !oldVolume && near.km <= NEAREST_MAX_KM && near.site.id !== nx.site) nx.selectSite(near.site.id);
    }
  }

  function choose(item: Item, at?: { x: number; y: number }) {
    if (item.kind === "place") {
      goTo(item.place);
      return;
    }
    chosen.current = item.site.icao;
    setQuery(item.site.icao);
    setOpen(false);
    pickRadar(item.site.id, at ?? centreOf(boxRef.current));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open || items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[active];
      if (it) choose(it);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="search" ref={boxRef}>
      <div className="search__field">
        <Search size={16} className="search__icon" />
        <input
          className="search__input"
          type="text"
          placeholder="Search a place or radar…"
          value={query}
          onChange={(e) => {
            chosen.current = null;
            setQuery(e.target.value);
          }}
          onFocus={() => {
            refreshSiteStatus();
            if (items.length > 0) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
        {loading && <Loader2 size={15} className="search__spin" />}
        {!loading && query.length > 0 && (
          <button
            type="button"
            className="search__clear"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              setResults([]);
              setOpen(false);
            }}
          >
            <X size={15} />
          </button>
        )}
        <button
          type="button"
          className="search__clear search__all"
          aria-label="All radars"
          title="All radars: a table to sort and filter"
          onClick={() => {
            setOpen(false);
            useRadarSitesStore.getState().setListOpen(true);
          }}
        >
          <List size={15} />
        </button>
      </div>

      {open && items.length > 0 && (
        <ul className="search__results" role="listbox">
          {items.map((it, i) => {
            const cls = it.kind === "radar" ? siteClass(it.site.id) : null;
            return (
              <li
                key={it.kind === "radar" ? `radar:${it.site.id}` : it.place.id}
                role="option"
                aria-selected={i === active}
                className={`search__item${i === active ? " is-active" : ""}${it.kind === "radar" ? " search__item--radar" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(it, { x: e.clientX, y: e.clientY });
                }}
              >
                {it.kind === "radar" ? (
                  <>
                    <RadioTower size={14} className="search__pin" />
                    <span className="search__label">
                      <b>{it.site.icao}</b> {placeOf(it.site)}
                      {it.site.state && it.site.state.trim() ? `, ${it.site.state}` : ""}
                    </span>
                    <span className="search__kind search__kind--radar">
                      <span className={`sitedot sitedot--${cls}`} />
                      {cls === "down" ? "down" : "radar"}
                    </span>
                  </>
                ) : (
                  <>
                    <MapPin size={14} className="search__pin" />
                    <span className="search__label">{it.place.label}</span>
                    {it.place.kind && <span className="search__kind">{it.place.kind}</span>}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function centreOf(el: HTMLElement | null): { x: number; y: number } | undefined {
  const r = el?.getBoundingClientRect();
  return r ? { x: r.left + 24, y: r.bottom + 4 } : undefined;
}
