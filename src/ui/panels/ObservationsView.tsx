import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronRight, Loader2, Search, X } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { LayerPower } from "../LayerPower";
import { Select } from "../Select";
import type { ObsCatalog, ObsProduct } from "../../lib/observations";
import { selectObsFrame, selectObsProduct, selectObsProducts, useObsStore } from "../../store/useObsStore";

const LAYER = "observations";

/** "HRRR analysis 3 km" -> "HRRR": the badge on a product another source draws. */
function shortName(catalog: ObsCatalog | null, id: string): string {
  const label = catalog?.sources.find((s) => s.id === id)?.label ?? id;
  return label.split(" ")[0];
}

function tick(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
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
  const groups = useMemo(
    () => groupProducts(q ? products.filter((p) => `${p.label} ${p.group} ${p.sub ?? ""}`.toLowerCase().includes(q)) : products),
    [products, q],
  );
  const here = catalog?.sources.find((s) => s.id === source);

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
                            <span className="obstree__where">{p.sources.map((s) => shortName(catalog, s)).join(" · ")}</span>
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
  const error = useObsStore((s) => s.error);
  const valid = useObsStore((s) => s.valid);
  const bar = useObsStore((s) => s.bar);
  const showLines = useObsStore((s) => s.showLines);
  const showEdge = useObsStore((s) => s.showEdge);
  const showBarbs = useObsStore((s) => s.showBarbs);
  const interval = useObsStore((s) => s.interval);
  const linesUnit = useObsStore((s) => s.linesUnit);
  const setShowLines = useObsStore((s) => s.setShowLines);
  const setShowEdge = useObsStore((s) => s.setShowEdge);
  const setShowBarbs = useObsStore((s) => s.setShowBarbs);
  const setSource = useObsStore((s) => s.setSource);
  const setIndex = useObsStore((s) => s.setIndex);
  const product = useObsStore(selectObsProduct);
  const frame = useObsStore(selectObsFrame);

  useEffect(() => {
    void useObsStore.getState().load();
  }, []);

  const src = catalog?.sources.find((s) => s.id === source);
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
        label="Observations (analysis)"
        on={enabled}
        error={!!error}
        onToggle={() => setLayerVisible(LAYER, !enabled)}
      />

      <div className={`sfx__status${error ? " is-error" : ""}`}>
        {busy ? (
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
          <span>Analysis</span>
          {src && <b>{src.coverage}</b>}
        </div>
        <Select
          value={source}
          onChange={setSource}
          aria-label="Analysis source"
          options={(catalog?.sources ?? []).map((s) => ({
            value: s.id,
            label: s.label,
            hint: `${s.products.length} products`,
          }))}
          placeholder={source}
        />
        {src && <div className="sfx__ends"><span>{src.note}</span></div>}
      </div>

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
          {showLines && product?.lines && interval ? (
            <b>
              every {tick(interval)} {linesUnit ?? ""}
            </b>
          ) : null}
        </div>
        <div className="sfx__chips">
          <button
            type="button"
            className={`sfx__chip${showLines ? " is-on" : ""}`}
            aria-pressed={showLines}
            disabled={product ? !product.lines : false}
            title={product && !product.lines ? "This product is shaded only" : undefined}
            onClick={() => setShowLines(!showLines)}
          >
            Lines and numbers
          </button>
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

      {bar && (
        <div className="sfx__block sfx__block--tight">
          <div className="sfx__head">
            <span>Scale</span>
            <b>{bar.labels ? "type" : bar.unit || "index"}</b>
          </div>
          <div className="obsbar" style={{ background: `linear-gradient(to right, ${bar.colors.join(", ")})` }} />
          <div className="obsbar__ticks">
            {bar.labels?.map((l) => (
              <span
                key={l.t}
                className="obsbar__tick"
                style={{ left: `${((l.v - bar.min) / (bar.max - bar.min)) * 100}%` }}
              >
                {l.t}
              </span>
            ))}
            {bar.ticks.map((t) => {
              const at = bar.max > bar.min ? ((t - bar.min) / (bar.max - bar.min)) * 100 : 0;
              // The end labels hang inward so they are not cut off by the panel.
              const edge = at < 4 ? " is-start" : at > 96 ? " is-end" : "";
              return (
                <span key={t} className={`obsbar__tick${edge}`} style={{ left: `${at}%` }}>
                  {tick(t)}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="sfx__block">
        <div className="sfx__head">
          <span>Hour</span>
          <b>{frames.length ? `${index + 1} / ${frames.length}` : "—"}</b>
        </div>
        <Select
          value={String(index)}
          onChange={(value) => setIndex(Number(value))}
          disabled={!frames.length}
          aria-label="Analysis hour"
          options={frames.map((f, i) => ({ value: String(i), label: f.label }))}
          placeholder="—"
        />
        <div className="sfx__ends">
          <span>{span}</span>
          <span>{frames.length} frames</span>
        </div>
      </div>

      <div className="sfx__block sfx__block--tight">
        <div className="mslp__note">
          Every hour of the last three days is a frame on the map timeline at the bottom, the same
          one radar scrubs on{frame ? ` (showing ${frame.label})` : ""}. RTMA is the finest surface
          analysis; the HRRR and RAP analyses add the upper air and the severe-weather parameters.
          An hour already looked at opens instantly, even after a restart.
        </div>
      </div>
    </div>
  );
}
