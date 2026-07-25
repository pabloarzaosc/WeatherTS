import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Search, X, Loader2, MapPin } from "lucide-react";

import { searchPlaces, type PlaceResult } from "../lib/photon";
import { getMap } from "../map/mapInstance";

export function SearchBar() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Debounced Photon query.
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
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
    setQuery(result.label);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[active];
      if (r) goTo(r);
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
          placeholder="Search a place…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
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
      </div>

      {open && results.length > 0 && (
        <ul className="search__results" role="listbox">
          {results.map((r, i) => (
            <li
              key={r.id}
              role="option"
              aria-selected={i === active}
              className={`search__item${i === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                goTo(r);
              }}
            >
              <MapPin size={14} className="search__pin" />
              <span className="search__label">{r.label}</span>
              {r.kind && <span className="search__kind">{r.kind}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
