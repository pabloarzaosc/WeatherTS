import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import maplibregl from "maplibre-gl";
import { Loader2, X } from "lucide-react";

import { buildBasemapStyle } from "../map/basemaps";
import { allMaps, getMapById, PRIMARY_PANE } from "../map/mapInstance";
import { useAppStore } from "../store/useAppStore";
import { useObsStore } from "../store/useObsStore";
import {
  fetchObsBar,
  fetchObsCompare,
  fetchObsView,
  fetchObsWindow,
  obsDensity,
  type ObsBar,
  type ObsCatalog,
  type ObsCompareCell,
  type ObsWindow,
} from "../lib/observations";
import { describe } from "../lib/patience";
import { Select, type SelectOption } from "./Select";

// Compare models: one valid time from whatever model and product each window
// is set to, side by side over the map area. (Compare runs is not a grid: it is
// the main map itself, flipping between runs -- see RunStrip.)
//
// The grid is its own place to look: zooming or dragging any of its maps moves
// all of them together and leaves the main map exactly where it was (that map
// also stops drawing while the grid covers it, so the grid's pictures are the
// only ones being made). The maps stay up while the timeline moves; only their
// pictures change, so a zoomed-in view survives scrubbing.

/** Columns for n maps: as square a grid as the count allows. */
function columns(n: number): number {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

/** The grid for n maps: its column tracks, and how many each map spans, so a
 *  short last row stretches across the width instead of leaving empty grey
 *  squares (14 maps in 4 columns: the last two are two columns wide). */
function layout(n: number): { tracks: number; span: (i: number) => number } {
  const c = columns(n);
  const rest = n % c;
  if (!rest) return { tracks: c, span: () => 1 };
  const lastRow = n - rest;
  return { tracks: c * rest, span: (i) => (i >= lastRow ? c : rest) };
}

const COUNTS = [2, 3, 4, 5, 6, 7, 8, 9];

/** A server out of requests for the minute (NOMADS): worth asking again soon,
 *  not an error to leave on the map. */
function busyServer(err: unknown): boolean {
  return /budget|rate limit|refusing requests|too many/i.test(err instanceof Error ? err.message : String(err));
}

/** The most windows the grid opens. Every window is a map of its own, and so
 *  a WebGL context of its own; a page gets about sixteen, and past that the
 *  browser takes the oldest away -- the main map, whose layers then fail on
 *  every update until a reload. The panes on screen count against it. */
function maxWindows(): number {
  return Math.max(2, 15 - allMaps().length);
}

/** The window counts on offer, and the grid's own when "All models" made it
 *  bigger -- never past what the page can hold. */
function counts(n: number, cap: number): number[] {
  const out = COUNTS.filter((c) => c <= cap);
  return out.includes(n) || n < 2 || n > cap ? out : [...out, n].sort((a, b) => a - b);
}

// The grid's maps, moved together. A move is copied once per animation frame,
// and the copies' own move events are not copied back.
const cellMaps = new Set<maplibregl.Map>();
if (import.meta.env.DEV) (window as unknown as { __cmpMaps?: Set<maplibregl.Map> }).__cmpMaps = cellMaps;
let syncing = false;
let leader: maplibregl.Map | null = null;
let frame = 0;
/** Where the grid is looking, for a map that joins it later (a models view
 *  with more maps than the runs view had). Null: start from the main map. */
let gridView: { center: maplibregl.LngLat; zoom: number } | null = null;

function follow(src: maplibregl.Map) {
  if (syncing) return;
  leader = src;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const from = leader;
    leader = null;
    if (!from) return;
    syncing = true;
    const view = { center: from.getCenter(), zoom: from.getZoom() };
    for (const m of cellMaps) if (m !== from) m.jumpTo(view);
    syncing = false;
    gridView = view;
  });
}

// What each models-grid window found at a valid time. The next hour is a new
// question; going back to one already seen is answered at once.
const WINDOW_TTL = 5 * 60_000;
const found = new Map<string, { at: number; cell: ObsCompareCell | null }>();
const failed = new Map<string, string>();
const asking = new Set<string>();

function windowKey(w: ObsWindow, unix: number): string {
  return `${w.source}|${w.field}|${w.run ?? ""}|${unix}`;
}

// Colour scales, one request per product however many windows show it.
const bars = new Map<string, Promise<ObsBar>>();
function barFor(field: string): Promise<ObsBar> {
  let p = bars.get(field);
  if (!p) {
    p = fetchObsBar(field);
    p.catch(() => bars.delete(field));
    bars.set(field, p);
  }
  return p;
}

/** Keeps a window's product when its new model has it; otherwise the model's
 *  2 m temperature, or the first thing it draws. A new model starts on its
 *  newest run. */
function fit(catalog: ObsCatalog | null, w: ObsWindow, newModel: boolean): ObsWindow {
  const src = catalog?.sources.find((s) => s.id === w.source);
  let field = w.field;
  if (src && !src.products.includes(field)) field = src.products.includes("t2m") ? "t2m" : src.products[0];
  return !newModel && w.run ? { source: w.source, field, run: w.run } : { source: w.source, field };
}

/** Models a window can open on its own: tracks are drawn on the one map, a
 *  storm model's domain is wherever its storm is, and a sub-hourly model is
 *  its hourly one again at a whole hour. */
function looseModels(catalog: ObsCatalog): string[] {
  return catalog.sources
    .filter((s) => !s.tracks && s.group !== "Tropical" && !s.id.endsWith("-subh"))
    .map((s) => s.id);
}

/** The models a new window reaches for first: the ones people set side by side,
 *  from different shelves, before the rest of the menu. */
const FIRST = ["hrrr-fc", "gfs-fc", "ecmwf-fc", "nam3-fc", "rap-fc", "icon-fc", "gdps-fc", "nam-fc", "aifs-fc"];

function byPreference(catalog: ObsCatalog): string[] {
  const loose = looseModels(catalog);
  return [...FIRST.filter((id) => loose.includes(id)), ...loose.filter((id) => !FIRST.includes(id))];
}

/** A first models grid: the model on screen, then other models with the same
 *  product, then other forecast models on their 2 m temperature. */
function seed(catalog: ObsCatalog, source: string, field: string, n: number): ObsWindow[] {
  const out: ObsWindow[] = [fit(catalog, { source, field }, true)];
  const order = byPreference(catalog).filter((id) => id !== source);
  const has = (id: string, f: string) => catalog.sources.find((s) => s.id === id)?.products.includes(f);
  const fc = (id: string) => catalog.sources.find((s) => s.id === id)?.forecast;
  for (const id of order) if (out.length < n && fc(id) && has(id, out[0].field)) out.push({ source: id, field: out[0].field });
  for (const id of order) {
    if (out.length >= n) break;
    if (!out.some((w) => w.source === id) && fc(id)) out.push(fit(catalog, { source: id, field: "t2m" }, true));
  }
  while (out.length < n) out.push(out[0]);
  return out;
}

/** One more window: a model not yet in the grid, on the product most of them show. */
function another(catalog: ObsCatalog, windows: ObsWindow[]): ObsWindow {
  const field = windows[windows.length - 1]?.field ?? "t2m";
  const used = new Set(windows.map((w) => w.source));
  const has = (id: string) => catalog.sources.find((s) => s.id === id)?.products.includes(field);
  const id = byPreference(catalog).find((x) => !used.has(x) && has(x)) ?? windows[0]?.source ?? catalog.defaultSource;
  return fit(catalog, { source: id, field }, true);
}

function modelOptions(catalog: ObsCatalog | null): SelectOption[] {
  return (catalog?.sources ?? []).filter((s) => !s.tracks).map((s) => ({ value: s.id, label: s.label, group: s.group }));
}

function productOptions(catalog: ObsCatalog | null, source: string): SelectOption[] {
  const src = catalog?.sources.find((s) => s.id === source);
  if (!catalog || !src) return [];
  return catalog.products
    .filter((p) => src.products.includes(p.id) && p.id.slice(0, 4) !== "trk_")
    .map((p) => ({ value: p.id, label: p.label, group: p.sub ? `${p.group} · ${p.sub}` : p.group, hint: p.unit || undefined }));
}

export function ObsCompare() {
  const view = useObsStore((s) => s.view);
  const setView = useObsStore((s) => s.setView);
  const source = useObsStore((s) => s.source);
  const field = useObsStore((s) => s.field);
  const catalog = useObsStore((s) => s.catalog);
  const windows = useObsStore((s) => s.windows);
  const setWindows = useObsStore((s) => s.setWindows);
  const frameNow = useObsStore((s) => s.frames[s.index]);
  const on = useAppStore((s) => s.layers.observations?.visible ?? false);
  const unix = frameNow?.unix;

  const [filling, setFilling] = useState(false);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // Asks again for windows that met a server out of requests for the minute.
  const [retry, setRetry] = useState(0);
  // "All models" found more than the page can hold.
  const [capNote, setCapNote] = useState<string | null>(null);
  // The picture each window last had: kept up while its next one is found.
  const shown = useRef<({ cell: ObsCompareCell | null; field: string } | undefined)[]>([]);

  const src = catalog?.sources.find((s) => s.id === source);
  const product = useMemo(() => catalog?.products.find((p) => p.id === field)?.label ?? field, [catalog, field]);
  const models = useMemo(() => modelOptions(catalog), [catalog]);
  const active = view === "models" && on && !!src && !src.tracks;
  // The product the windows last took from the panel; null while closed.
  const followed = useRef<string | null>(null);

  // A fresh grid starts on the main map's view; a grid already open keeps its own.
  useEffect(() => {
    if (!active) gridView = null;
  }, [active]);

  // A models grid opened for the first time starts from what is on screen.
  useEffect(() => {
    if (active && catalog && !windows.length) setWindows(seed(catalog, source, field, 4));
  }, [active, catalog, windows.length, source, field, setWindows]);

  // A product picked on the panel goes to every window whose model has it. A
  // remembered grid opening again takes it too, unless its windows were set
  // to different products -- that grid was made on purpose.
  useEffect(() => {
    if (!active || !catalog) {
      followed.current = null;
      return;
    }
    if (followed.current === field) return;
    const opening = followed.current === null;
    followed.current = field;
    const ws = useObsStore.getState().windows;
    if (!ws.length) return;
    const mixed = ws.some((w) => w.field !== ws[0].field);
    if (opening && (mixed || ws[0].field === field)) return;
    const has = (id: string) => catalog.sources.find((s) => s.id === id)?.products.includes(field);
    const next = ws.map((w) => (w.field !== field && has(w.source) ? { ...w, field } : w));
    if (next.some((w, i) => w !== ws[i])) setWindows(next);
  }, [active, catalog, field, setWindows]);

  // Each window asks for its own model's hour at the timeline's time.
  useEffect(() => {
    if (!active || unix == null) return;
    const ctrl = new AbortController();
    for (const w of windows.slice(0, maxWindows())) {
      const k = windowKey(w, unix);
      const hit = found.get(k);
      if ((hit && Date.now() - hit.at < WINDOW_TTL) || asking.has(k)) continue;
      asking.add(k);
      failed.delete(k);
      fetchObsWindow(w, unix, ctrl.signal)
        .then((cell) => {
          found.set(k, { at: Date.now(), cell });
          if (found.size > 400) found.delete(found.keys().next().value as string);
        })
        .catch((err) => {
          if (ctrl.signal.aborted) return;
          if (busyServer(err)) window.setTimeout(() => setRetry((n) => n + 1), 8000 + Math.random() * 6000);
          else failed.set(k, describe(err, "This window"));
        })
        .finally(() => {
          asking.delete(k);
          if (!ctrl.signal.aborted) bump();
        });
    }
    return () => ctrl.abort();
  }, [active, unix, windows, retry]);

  if (!active) return null;
  const when = unix != null ? new Date(unix * 1000).toISOString().slice(5, 16).replace("T", " ") + "Z" : "";

  const edit = (i: number, patch: Partial<ObsWindow>) => {
    const next = windows.map((w, j) => (j === i ? fit(catalog, { ...w, ...patch }, patch.source != null && patch.source !== w.source) : w));
    setCapNote(null);
    setWindows(next);
  };

  /** Every model that has the panel's product at this hour, one window each. */
  const fillAll = () => {
    if (unix == null || filling) return;
    setFilling(true);
    fetchObsCompare(source, field, unix, "models")
      .then((got) => {
        const next: ObsWindow[] = got.map((c) => ({ source: c.source, field }));
        if (!next.some((w) => w.source === source)) next.unshift({ source, field });
        const most = maxWindows();
        setCapNote(
          next.length > most
            ? `${next.length} models have it; ${most} windows is as many as the page can draw` +
                (allMaps().length > 1 ? " beside these panes" : "")
            : null,
        );
        setWindows(next.slice(0, most));
      })
      .catch(() => {
        /* the grid stays as it was */
      })
      .finally(() => setFilling(false));
  };

  const resize = (n: number) => {
    if (!catalog) return;
    setCapNote(null);
    const next = windows.slice(0, n);
    while (next.length < n) next.push(another(catalog, next));
    setWindows(next);
  };

  const pickers = (i: number, cellSource: string, cellField: string): ReactNode => (
    <>
      <Select
        className="obscmp__pick"
        value={cellSource}
        onChange={(v) => edit(i, { source: v })}
        options={models}
        aria-label="Model"
        popWidth={230}
      />
      <Select
        className="obscmp__pick obscmp__pick--product"
        value={cellField}
        onChange={(v) => edit(i, { field: v })}
        options={productOptions(catalog, cellSource)}
        aria-label="Product"
        popWidth={300}
      />
    </>
  );

  const cap = maxWindows();
  const open = windows.slice(0, cap);
  const grid = layout(open.length);

  return (
    <section className="obscmp is-windows" aria-label="Compare models">
      <header className="obscmp__head">
        <span className="obscmp__mode">Compare models</span>
        <span className="obscmp__what">valid {when}</span>
        <Select
          className="obscmp__count"
          value={String(open.length || 4)}
          onChange={(v) => resize(Number(v))}
          options={counts(open.length, cap).map((n) => ({ value: String(n), label: `${n} windows` }))}
          aria-label="Windows"
        />
        <button
          type="button"
          className="obscmp__all"
          onClick={fillAll}
          disabled={filling || unix == null}
          title={`A window for every model that has ${product} at this hour`}
        >
          {filling && <Loader2 size={11} className="sfx__status-spin" />}
          {filling ? "Finding…" : "All models"}
        </button>
        <button
          type="button"
          className="obscmp__reset"
          onClick={() => {
            setCapNote(null);
            if (catalog) setWindows(seed(catalog, source, field, Math.min(open.length || 4, cap)));
          }}
          title="Start again from the model and product on the panel"
        >
          Reset
        </button>
        <span className="obscmp__hint">{capNote ?? "Pick any model and product per window · scroll or drag to zoom all"}</span>
        <button type="button" className="obscmp__close" onClick={() => setView("single")} aria-label="Back to one map">
          <X size={14} />
        </button>
      </header>
      {!open.length ? (
        <div className="obscmp__msg">
          <Loader2 size={13} className="sfx__status-spin" /> Setting up the windows…
        </div>
      ) : (
        <div className="obscmp__grid" style={{ gridTemplateColumns: `repeat(${grid.tracks}, minmax(0, 1fr))` }}>
          {open.map((w, i) => {
            const k = unix != null ? windowKey(w, unix) : "";
            const hit = found.get(k);
            const waiting = !hit && !failed.has(k);
            if (hit) shown.current[i] = { cell: hit.cell, field: w.field };
            // Still being found: the last picture stays, with the product it was drawn in.
            const last = waiting ? shown.current[i] : undefined;
            const cell = hit ? hit.cell : (last?.cell ?? null);
            const label = catalog?.sources.find((s) => s.id === w.source)?.label ?? w.source;
            const note = failed.get(k) ?? (hit && !hit.cell ? `${label} has no hour within three of ${when}.` : null);
            return (
              <CompareCell
                key={i}
                cell={cell}
                field={last?.field ?? w.field}
                head={pickers(i, w.source, w.field)}
                sub={hit?.cell?.sub ?? (waiting ? "…" : "")}
                waiting={waiting}
                note={note}
                bar={w.field}
                span={grid.span(i)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

/** The first label layer of a basemap: the picture goes under the place names. */
function firstSymbol(map: maplibregl.Map): string | undefined {
  return map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
}

type Box = { west: number; south: number; east: number; north: number };

/** Up to five of a scale's ticks, spread out: a window is a third of the map wide. */
function someTicks(bar: ObsBar): { v: number; t: string }[] {
  if (bar.labels) return bar.labels;
  const t = bar.ticks;
  const every = Math.max(1, Math.ceil(t.length / 5));
  return t
    .filter((_, i) => i % every === 0)
    .map((v) => ({ v, t: (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(Math.abs(v) < 10 ? 1 : 0)).replace(/\.0$/, "") }));
}

function CellBar({ field }: { field: string }) {
  const [bar, setBar] = useState<ObsBar | null>(null);
  useEffect(() => {
    let live = true;
    barFor(field)
      .then((b) => live && setBar(b))
      .catch(() => live && setBar(null));
    return () => {
      live = false;
    };
  }, [field]);
  if (!bar) return null;
  const span = bar.max - bar.min || 1;
  return (
    <div className="obscmp__bar" aria-hidden>
      <div className="obscmp__strip" style={{ background: `linear-gradient(to right, ${bar.colors.join(", ")})` }} />
      <div className="obscmp__ticks">
        {someTicks(bar).map((l) => {
          const pct = Math.min(100, Math.max(0, ((l.v - bar.min) / span) * 100));
          const shift = pct < 6 ? "0" : pct > 94 ? "-100%" : "-50%";
          return (
            <span key={`${l.v}-${l.t}`} style={{ left: `${pct}%`, transform: `translateX(${shift})` }}>
              {l.t}
            </span>
          );
        })}
        {bar.unit && <b>{bar.unit}</b>}
      </div>
    </div>
  );
}

function CompareCell({
  cell,
  field,
  head,
  sub,
  waiting = false,
  note = null,
  bar,
  span = 1,
}: {
  cell: ObsCompareCell | null;
  field: string;
  head: ReactNode;
  sub: string;
  /** Its hour is still being found (a models-grid window). */
  waiting?: boolean;
  /** Why there is no picture: nothing near this hour, or it failed. */
  note?: string | null;
  /** The product whose scale the window shows along its foot, when windows differ. */
  bar?: string;
  /** Grid tracks it spans: more for a short last row. */
  span?: number;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const want = useRef({ cell, field });
  want.current = { cell, field };
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  // The map: made once for this place in the grid, and moved with the others.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const main = getMapById(PRIMARY_PANE);
    const map = new maplibregl.Map({
      container: el,
      style: buildBasemapStyle(useAppStore.getState().basemapId),
      ...(gridView
        ? { center: gridView.center, zoom: gridView.zoom }
        : main
          ? { bounds: main.getBounds() }
          : {}),
      attributionControl: false,
      fadeDuration: 0,
      renderWorldCopies: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      keyboard: false,
    });
    map.touchZoomRotate.disableRotation();
    cellMaps.add(map);

    let ctrl: AbortController | null = null;
    let shown: string | null = null;
    let timer = 0;
    let again = 0;
    let ready = false;
    let removed = false;

    const clear = () => {
      if (map.getLayer("cmp")) map.removeLayer("cmp");
      if (map.getSource("cmp")) map.removeSource("cmp");
      if (shown) URL.revokeObjectURL(shown);
      shown = null;
    };

    const draw = async () => {
      if (!ready || removed) return;
      ctrl?.abort();
      window.clearTimeout(again);
      const mine = new AbortController();
      ctrl = mine;
      setQueued(false);
      const { cell: c, field: f } = want.current;
      if (!c) {
        clear();
        setBusy(false);
        setError(null);
        return;
      }
      const b = map.getBounds();
      const box: Box = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
      setBusy(true);
      try {
        const k = obsDensity();
        const blob = await fetchObsView(c, f, box, el.clientWidth * k, el.clientHeight * k, mine.signal);
        if (mine.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        // Decoded before the map is handed it: the map's own load is then at
        // once, and a window closed meanwhile never gets a picture half-loaded.
        await new Promise<void>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("the picture did not decode"));
          img.src = url;
        });
        if (mine.signal.aborted || removed) {
          URL.revokeObjectURL(url);
          return;
        }
        const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
          [box.west, box.north],
          [box.east, box.north],
          [box.east, box.south],
          [box.west, box.south],
        ];
        const opacity = useAppStore.getState().layers.observations?.opacity ?? 0.75;
        const existing = map.getSource("cmp") as maplibregl.ImageSource | undefined;
        if (existing) existing.updateImage({ url, coordinates });
        else {
          map.addSource("cmp", { type: "image", url, coordinates });
          map.addLayer(
            { id: "cmp", type: "raster", source: "cmp", paint: { "raster-opacity": opacity, "raster-fade-duration": 0 } },
            firstSymbol(map),
          );
        }
        if (shown) URL.revokeObjectURL(shown);
        shown = url;
        setError(null);
      } catch (err) {
        if (mine.signal.aborted) return;
        if (busyServer(err)) {
          // NOMADS allows so many requests a minute; a grid of its models
          // can use them up. The picture comes once there is room again.
          setError(null);
          setQueued(true);
          again = window.setTimeout(() => void draw(), 8000 + Math.random() * 6000);
          return;
        }
        setError(describe(err, "This map"));
        setBusy(false);
        return;
      }
      if (!mine.signal.aborted) setBusy(false);
    };
    drawRef.current = () => void draw();

    // A zoomed-in view is drawn again for what is now on screen, sharp.
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void draw(), 250);
    };
    const onMove = () => follow(map);
    map.on("move", onMove);
    map.on("moveend", settle);
    map.on("load", () => {
      ready = true;
      void draw();
    });
    const ro = new ResizeObserver(() => {
      map.resize();
      settle();
    });
    ro.observe(el);

    return () => {
      cellMaps.delete(map);
      map.off("move", onMove);
      map.off("moveend", settle);
      ro.disconnect();
      removed = true;
      ctrl?.abort();
      window.clearTimeout(timer);
      window.clearTimeout(again);
      // The picture off the map first: a load MapLibre still has under way
      // otherwise reports back to a map that is gone ("reading 'getLayer'").
      try {
        clear();
      } catch {
        /* the style never loaded: nothing to take off */
      }
      map.remove();
    };
  }, []);

  // A new hour, run, model or product: the same map, a new picture.
  useEffect(() => {
    drawRef.current();
  }, [cell?.source, cell?.key, field]);

  const problem = note ?? error;
  return (
    <div className={`obscmp__cell${bar ? " has-bar" : ""}`} style={span > 1 ? { gridColumn: `span ${span}` } : undefined}>
      <div ref={host} className="obscmp__map" />
      <div className="obscmp__label">
        <div className="obscmp__picks">
          {head}
          {(busy || waiting) && <Loader2 size={11} className="sfx__status-spin" />}
        </div>
        {(queued || sub) && <span className="obscmp__sub">{queued ? "NOMADS busy · trying again shortly" : sub}</span>}
      </div>
      {problem && <div className="obscmp__err">{problem}</div>}
      {bar && <CellBar field={bar} />}
    </div>
  );
}
