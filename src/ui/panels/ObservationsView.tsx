import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronRight, Loader2, Search, X } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { LayerPower } from "../LayerPower";
import { useArchiveStore } from "../../store/useArchiveStore";
import { Select } from "../Select";
import { fhText, type ObsCatalog, type ObsProduct, type ObsView } from "../../lib/observations";
import {
  OBS_LOOP_HOURS,
  selectObsFrame,
  selectObsProduct,
  selectObsProducts,
  useObsStore,
} from "../../store/useObsStore";
import { spanLabel, stepLabel } from "../../lib/loopTime";

const LAYER = "observations";
/** The spans a forecast model's Replay offers: up to the week its analysis keeps. */
const REPLAY_HOURS = [24, 48, 72, 168];

/** "HRRR analysis 3 km" -> "HRRR": the badge on a product another source draws. */
/** "2026092118" -> "Mon 21 Sep 18Z". */
function fmtRun(run: string): string {
  // A tropical model's run names its storm too: "2026092212~polo17e".
  const [stamp, storm] = run.split("~");
  const d = new Date(Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(8, 10)));
  const wd = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const mo = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const when = `${wd} ${d.getUTCDate()} ${mo} ${String(d.getUTCHours()).padStart(2, "0")}Z`;
  if (!storm) return when;
  const m = /^([a-z]*)(\d\d[a-z])$/.exec(storm);
  const name = m ? `${m[2].toUpperCase()}${m[1] ? ` ${m[1].toUpperCase()}` : ""}` : storm.toUpperCase();
  return `${name} · ${when}`;
}

const VIEWS: [ObsView, string][] = [
  ["single", "Single"],
  ["runs", "Compare runs"],
  ["models", "Compare models"],
];

/** How long ago a run started: "5 h ago". */
function ago(unix: number): string {
  const h = Math.max(0, Math.round((Date.now() / 1000 - unix) / 3600));
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function shortName(catalog: ObsCatalog | null, id: string): string {
  const label = catalog?.sources.find((s) => s.id === id)?.label ?? id;
  return label.split(" ")[0];
}

/** Where a product the current model lacks can be had: two models and a count
 *  ("HRRR · RAP +12"); the full list is in the row's tooltip. */
function whereText(catalog: ObsCatalog | null, sources: string[]): string {
  const names = [...new Set(sources.map((s) => shortName(catalog, s)))];
  return names.length > 2 ? `${names.slice(0, 2).join(" · ")} +${names.length - 2}` : names.join(" · ");
}

interface Group {
  name: string;
  /** Sub-headings in catalogue order; null holds the products without one. */
  subs: { name: string | null; products: ObsProduct[] }[];
  count: number;
}

function groupProducts(products: ObsProduct[]): Group[] {
  const groups: Group[] = [];
  for (const p of products) {
    let g = groups.find((x) => x.name === p.group);
    if (!g) {
      g = { name: p.group, subs: [], count: 0 };
      groups.push(g);
    }
    let sub = g.subs.find((x) => x.name === p.sub);
    if (!sub) {
      sub = { name: p.sub, products: [] };
      g.subs.push(sub);
    }
    sub.products.push(p);
    g.count += 1;
  }
  return groups;
}

/**
 * Every product, grouped the way a forecaster looks for one: Surface, Upper-Air,
 * Severe Weather. Products the chosen source cannot draw stay in the list with
 * the sources that can -- picking one moves there -- because hiding CAPE when
 * RTMA is selected would make it look like the app has no CAPE at all.
 */
function ProductTree() {
  const catalog = useObsStore((s) => s.catalog);
  const source = useObsStore((s) => s.source);
  const field = useObsStore((s) => s.field);
  const openGroups = useObsStore((s) => s.openGroups);
  const toggleGroup = useObsStore((s) => s.toggleGroup);
  const setField = useObsStore((s) => s.setField);
  const products = useObsStore(selectObsProducts);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const here = catalog?.sources.find((s) => s.id === source);
  const groups = useMemo(() => {
    const all = groupProducts(q ? products.filter((p) => `${p.label} ${p.group} ${p.sub ?? ""}`.toLowerCase().includes(q)) : products);
    // The groups this source draws first: on the radar mosaic its hail and
    // rotation lead, on a model its surface and upper air, each with the other's
    // products further down for moving over to.
    const offers = new Set(here?.products ?? []);
    const has = (g: Group) => g.subs.some((s) => s.products.some((p) => offers.has(p.id)));
    return [...all.filter(has), ...all.filter((g) => !has(g))];
  }, [products, q, here]);

  return (
    <div className="obstree">
      <label className="obstree__find">
        <Search size={12} aria-hidden />
        <input
          type="search"
          value={query}
          placeholder="Find a product"
          aria-label="Find a product"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button type="button" aria-label="Clear" onClick={() => setQuery("")}>
            <X size={12} />
          </button>
        )}
      </label>

      {groups.length === 0 && <div className="obstree__empty">Nothing called “{query}”</div>}

      {groups.map((g) => {
        // A search opens every group it found something in.
        const open = q !== "" || openGroups.includes(g.name);
        const holdsCurrent = g.subs.some((s) => s.products.some((p) => p.id === field));
        return (
          <div key={g.name} className={`obstree__group${open ? " is-open" : ""}`}>
            <button
              type="button"
              className={`obstree__head${holdsCurrent ? " has-current" : ""}`}
              aria-expanded={open}
              onClick={() => toggleGroup(g.name)}
              disabled={q !== ""}
            >
              <ChevronRight size={13} className="obstree__chev" aria-hidden />
              <span>{g.name}</span>
              <b>{g.count}</b>
            </button>
            {open && (
              <div className="obstree__body">
                {g.subs.map((sub) => (
                  <div key={sub.name ?? "-"} className="obstree__sub">
                    {sub.name && <div className="obstree__subname">{sub.name}</div>}
                    {sub.products.map((p) => {
                      const offered = here?.products.includes(p.id) ?? true;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className={`obstree__item${p.id === field ? " is-on" : ""}${offered ? "" : " is-elsewhere"}`}
                          aria-pressed={p.id === field}
                          title={offered ? p.note || p.label : `${p.label} — from ${p.sources.map((s) => shortName(catalog, s)).join(" or ")}`}
                          onClick={() => setField(p.id)}
                        >
                          <span className="obstree__label">{p.label}</span>
                          {!offered && (
                            <span className="obstree__where">{whereText(catalog, p.sources)}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Analysis products: the observed state of the atmosphere, hour by hour. */
export function ObservationsView() {
  const enabled = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const catalog = useObsStore((s) => s.catalog);
  const source = useObsStore((s) => s.source);
  const frames = useObsStore((s) => s.frames);
  const index = useObsStore((s) => s.index);
  const busy = useObsStore((s) => s.busy);
  const loopLoaded = useObsStore((s) => s.loopLoaded);
  const loopTotal = useObsStore((s) => s.loopTotal);
  const loopArmed = useObsStore((s) => s.loopArmed);
  const hours = useObsStore((s) => s.hours);
  const setHours = useObsStore((s) => s.setHours);
  const error = useObsStore((s) => s.error);
  const valid = useObsStore((s) => s.valid);
  const showEdge = useObsStore((s) => s.showEdge);
  const showBarbs = useObsStore((s) => s.showBarbs);
  const setShowEdge = useObsStore((s) => s.setShowEdge);
  const setShowBarbs = useObsStore((s) => s.setShowBarbs);
  const showPlaces = useObsStore((s) => s.showPlaces);
  const setShowPlaces = useObsStore((s) => s.setShowPlaces);
  const showRoads = useObsStore((s) => s.showRoads);
  const setShowRoads = useObsStore((s) => s.setShowRoads);
  const setSource = useObsStore((s) => s.setSource);
  const replay = useObsStore((s) => s.replay);
  const setIndex = useObsStore((s) => s.setIndex);
  const pickedRun = useObsStore((s) => s.run);
  const runs = useObsStore((s) => s.runs);
  const setRun = useObsStore((s) => s.setRun);
  const view = useObsStore((s) => s.view);
  const setView = useObsStore((s) => s.setView);
  const product = useObsStore(selectObsProduct);
  const frame = useObsStore(selectObsFrame);

  useEffect(() => {
    void useObsStore.getState().load();
  }, []);

  const src = catalog?.sources.find((s) => s.id === source);
  const forecast = src?.forecast ?? false;
  const archive = src?.archive;
  // A run only looks ahead; its analysis twin holds every hour of the week.
  const replaySrc = forecast && src?.replay && product
    ? catalog?.sources.find((s) => s.id === src.replay && s.products.includes(product.id))
    : undefined;
  // And back from the past to the model's forecast of the same product.
  const forecastSrc = !forecast && product
    ? catalog?.sources.find((s) => s.forecast && s.replay === source && s.products.includes(product.id) &&
        !s.id.includes("subh"))
    : undefined;
  const run = forecast ? frames[0]?.run : undefined;

  // The runs to pick from, fetched when a forecast model opens and again every
  // few minutes, as new ones come out.
  useEffect(() => {
    if (!forecast) return;
    const load = () => void useObsStore.getState().loadRuns();
    load();
    const timer = window.setInterval(load, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [source, forecast]);
  const step = useMemo(() => stepLabel(frames.map((f) => f.unix)), [frames]);
  const productLabel = product?.label ?? "";
  const span =
    frames.length >= 2
      ? `${frames[0].label} → ${frames[frames.length - 1].label}`
      : frames.length === 1
        ? frames[0].label
        : "—";

  return (
    <div className="sfx">
      <LayerPower
        label="Models"
        on={enabled}
        error={!!error}
        onToggle={() => setLayerVisible(LAYER, !enabled)}
      />

      <div className={`sfx__status${error ? " is-error" : ""}`}>
        {enabled && loopArmed && loopTotal > 0 && loopLoaded < loopTotal ? (
          <>
            <Loader2 size={13} className="sfx__status-spin" /> Loading loop {loopLoaded}/{loopTotal}
          </>
        ) : busy ? (
          <>
            <Loader2 size={13} className="sfx__status-spin" /> Drawing {productLabel}…
          </>
        ) : error ? (
          <>
            <AlertTriangle size={13} /> {error}
          </>
        ) : enabled && valid ? (
          <>{valid}</>
        ) : (
          <>Ready</>
        )}
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Model</span>
          {src && <b>{src.coverage}</b>}
        </div>
        <Select
          value={source}
          onChange={setSource}
          aria-label="Model"
          options={(catalog?.sources ?? []).filter((s) => !s.archive).map((s) => ({
            value: s.id,
            label: s.label,
            hint: `${s.products.length} products`,
            group: s.group,
          }))}
          placeholder={src?.label ?? source}
        />
        {src && <div className="sfx__ends"><span>{src.note}</span></div>}
      </div>

      {archive && (
        <div className="sfx__block">
          <div className="sfx__ends">
            <span>
              The map is on the mesoanalysis archive. Its day, hour and radar are set in the Archive panel of the
              catalog.
            </span>
          </div>
          <div className="sfx__chips">
            <button type="button" className="sfx__chip sfx__chip--wide" onClick={() => useArchiveStore.getState().backToLive()}>
              Back to live analyses
            </button>
          </div>
        </div>
      )}

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Product</span>
          {product && <b className="obstree__current">{product.label}</b>}
        </div>
        <ProductTree />
        {product?.note && <div className="sfx__ends"><span>{product.note}</span></div>}
      </div>

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Draw</span>
        </div>
        <div className="sfx__chips">
          <button
            type="button"
            className={`sfx__chip${showBarbs ? " is-on" : ""}`}
            aria-pressed={showBarbs}
            disabled={product ? !product.barbs : false}
            title={product && !product.barbs ? "This product carries no wind" : undefined}
            onClick={() => setShowBarbs(!showBarbs)}
          >
            Wind barbs
          </button>
          <button
            type="button"
            className={`sfx__chip${showPlaces ? " is-on" : ""}`}
            aria-pressed={showPlaces}
            title="State, city and town names over the field, with the value at each"
            onClick={() => setShowPlaces(!showPlaces)}
          >
            Places and values
          </button>
          <button
            type="button"
            className={`sfx__chip${showRoads ? " is-on" : ""}`}
            aria-pressed={showRoads}
            title="Highways from a state's view in, streets at city zoom, and the towns' built-up area"
            onClick={() => setShowRoads(!showRoads)}
          >
            Roads and towns
          </button>
          <button
            type="button"
            className={`sfx__chip${showEdge ? " is-on" : ""}`}
            aria-pressed={showEdge}
            onClick={() => setShowEdge(!showEdge)}
          >
            Edge of the data
          </button>
        </div>
        <div className="sfx__ends">
          <span>Hover the map for the value under the pointer</span>
        </div>
      </div>

      {!forecast && !archive && (
      <div className="sfx__block">
        <div className="sfx__head">
          <span>Loop</span>
          <b>
            {spanLabel(hours)}
            {step ? ` · every ${step}` : ""}
          </b>
        </div>
        <div className="sfx__chips">
          {OBS_LOOP_HOURS.map((h) => (
            <button
              key={h}
              type="button"
              className={`sfx__chip${h === hours ? " is-on" : ""}`}
              aria-pressed={h === hours}
              onClick={() => setHours(h)}
            >
              {spanLabel(h)}
            </button>
          ))}
        </div>
        <div className="sfx__ends">
          <span>
            Press play to download the loop. Every frame up to 240 of them: a week of every hour is
            hundreds of MB.
          </span>
        </div>
        {forecastSrc && (
          <div className="sfx__chips">
            <button type="button" className="sfx__chip" onClick={() => setSource(forecastSrc.id)}>
              Back to the {forecastSrc.label} forecast
            </button>
          </div>
        )}
      </div>
      )}

      {src && !src.tracks && (
        <div className="sfx__block">
          <div className="sfx__head">
            <span>View</span>
          </div>
          <div className="sfx__chips">
            {/* An analysis has no runs to compare, but a models grid can sit beside it. */}
            {VIEWS.filter(([v]) => forecast || v !== "runs").map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={`sfx__chip${view === v ? " is-on" : ""}`}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="sfx__ends">
            <span>
              {view === "runs"
                ? "The map holds the valid time on the timeline; the strip below it lists the runs that forecast it, oldest first. Pick one, or play them to see how the forecast changed."
                : view === "models"
                  ? "Any model and any product in each window, all at the timeline's valid time. Pick them in the windows; the grid is remembered."
                  : "One map. The compare views keep following the timeline."}
            </span>
          </div>
        </div>
      )}

      {replaySrc && (
        <div className="sfx__block">
          <div className="sfx__head">
            <span>Replay</span>
            <b>{product?.label}</b>
          </div>
          <div className="sfx__chips">
            {REPLAY_HOURS.map((h) => (
              <button key={h} type="button" className="sfx__chip" onClick={() => replay(replaySrc.id, h)}>
                Last {spanLabel(h)}
              </button>
            ))}
          </div>
          <div className="sfx__ends">
            <span>
              A run only looks ahead. The replay goes back: the first hour of every {src?.label} run, one frame an
              hour, up to a week ({replaySrc.label}).
            </span>
          </div>
        </div>
      )}

      {forecast && (
        <div className="sfx__block">
          <div className="sfx__head">
            <span>Run</span>
            <b>{run ? fmtRun(run) : "—"}</b>
          </div>
          <Select
            value={pickedRun ?? ""}
            onChange={(value) => setRun(value || null)}
            aria-label="Run"
            options={[
              { value: "", label: "Newest full-length run", hint: !pickedRun && run ? fmtRun(run) : undefined },
              ...runs.map((r) => ({
                value: r.run,
                label: r.label ?? fmtRun(r.run),
                hint: r.hours != null ? `${r.hours} h · ${ago(r.unix)}` : ago(r.unix),
              })),
            ]}
          />
          <div className="sfx__ends">
            <span>
              Opens on the newest run that goes the whole way (HRRR 48 h, RAP 51 h); another run opens on the same
              valid time, to see how the forecast changed.
            </span>
          </div>
        </div>
      )}

      <div className="sfx__block">
        <div className="sfx__head">
          <span>{forecast ? "Forecast hour" : "Hour"}</span>
          <b>
            {frames.length
              ? forecast && frame?.fh != null
                ? fhText(frame)
                : `${index + 1} / ${frames.length}`
              : "—"}
          </b>
        </div>
        <Select
          value={String(index)}
          onChange={(value) => setIndex(Number(value))}
          disabled={!frames.length}
          aria-label={forecast ? "Forecast hour" : "Analysis hour"}
          options={frames.map((f, i) => ({ value: String(i), label: f.label }))}
          placeholder="—"
        />
        <div className="sfx__ends">
          <span>{forecast && run ? `Run ${fmtRun(run)}` : span}</span>
          <span>{frames.length} {forecast ? "hours" : "frames"}</span>
        </div>
      </div>

      <div className="sfx__block sfx__block--tight">
        <div className="mslp__note">
          {archive
            ? `The day's 24 hours are the frames on the map timeline. An hour is read whole from NOAA's
               archive the first time (a few seconds; the years before 2021 come from NCEI, slower) and opens
               instantly after. The severe parameters are worked out from each hour's own profile, the same
               way for every year: SB, ML (lowest 100 mb) and MU (lowest 300 mb) parcels, the effective inflow
               layer, Bunkers storm motion.`
            : forecast
            ? `The run's forecast hours are the frames on the map timeline; the newest run opens on the
               hour nearest now. A run still coming in shows the hours already out.`
            : `Every hour of the last three days is a frame on the map timeline at the bottom, the same
               one radar scrubs on${frame ? ` (showing ${frame.label})` : ""}. RTMA is the finest surface
               analysis; the HRRR and RAP analyses add the upper air and the severe-weather parameters.
               An hour already looked at opens instantly, even after a restart.`}
        </div>
      </div>
    </div>
  );
}
