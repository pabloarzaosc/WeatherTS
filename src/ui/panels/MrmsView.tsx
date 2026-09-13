import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Search, SkipForward, X } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { useMrmsStore } from "../../store/useMrmsStore";
import { LayerPower } from "../LayerPower";

const LAYER = "mrms";

/**
 * The MRMS picker.
 *
 * A hundred products is too many for a flat list and too many for a dropdown,
 * so this is a search box over grouped rows: type "hail" or "rotation" and the
 * list collapses to what you meant. The groups are the ones MRMS itself
 * publishes in, which is also the order a chaser thinks in -- reflectivity,
 * then what the reflectivity implies.
 *
 * Region sits above the search rather than beside a product, because it
 * changes what every row below it means. Not every product exists in every
 * region: Alaska publishes about 114 of them, so a row that comes back empty
 * there is coverage, not breakage.
 */
export function MrmsView() {
  const on = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const products = useMrmsStore((s) => s.products);
  const regions = useMrmsStore((s) => s.regions);
  const product = useMrmsStore((s) => s.product);
  const region = useMrmsStore((s) => s.region);
  const meta = useMrmsStore((s) => s.meta);
  const loading = useMrmsStore((s) => s.loading);
  const error = useMrmsStore((s) => s.error);
  const frames = useMrmsStore((s) => s.frames);
  const frameKey = useMrmsStore((s) => s.frameKey);
  const setFrameKey = useMrmsStore((s) => s.setFrameKey);
  const setProduct = useMrmsStore((s) => s.setProduct);
  const setRegion = useMrmsStore((s) => s.setRegion);
  const loadCatalog = useMrmsStore((s) => s.loadCatalog);

  const [q, setQ] = useState("");

  // The catalog is wanted as soon as the panel opens, not only once the layer
  // is switched on -- otherwise the list is empty until you commit to it.
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = new Map<string, typeof products>();
    for (const p of products) {
      if (needle && !`${p.label} ${p.group}`.toLowerCase().includes(needle)) continue;
      const list = out.get(p.group) ?? [];
      list.push(p);
      out.set(p.group, list);
    }
    return [...out.entries()];
  }, [products, q]);

  const hits = groups.reduce((n, [, list]) => n + list.length, 0);
  const missing = products.filter((p) => !p.available).length;
  const regionLabel = regions.find((r) => r.id === region)?.label ?? region;

  // "" means live, which is the last frame. Resolving it to an index lets the
  // arrows step back from live without a special case for the first press.
  const atIndex = frameKey ? frames.findIndex((f) => f.key === frameKey) : frames.length - 1;
  const live = !frameKey;
  const step = (by: number) => {
    if (!frames.length) return;
    const next = Math.max(0, Math.min(frames.length - 1, (atIndex < 0 ? frames.length - 1 : atIndex) + by));
    setFrameKey(next === frames.length - 1 ? "" : frames[next].key);
  };
  const shown = frames[atIndex] ?? null;

  return (
    <div className="mrms">
      <LayerPower
        label="MRMS mosaic"
        on={on}
        error={!!error}
        onToggle={() => setLayerVisible(LAYER, !on)}
      />

      {error && (
        <p className="mrms__err" role="alert">
          {error}
        </p>
      )}

      <div className="mrms__regions" role="tablist" aria-label="Region">
        {regions.map((r) => (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={region === r.id}
            className={`mrms__region${region === r.id ? " is-on" : ""}`}
            onClick={() => setRegion(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="mrms__search">
        <Search size={12} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search 106 products — hail, rotation, QPE…"
          aria-label="Search MRMS products"
        />
        {q && (
          <button type="button" onClick={() => setQ("")} aria-label="Clear search">
            <X size={12} />
          </button>
        )}
      </div>

      {missing > 0 && (
        <p className="mrms__coverage">
          {missing} of {products.length} not published for {regionLabel}
        </p>
      )}

      <div className="mrms__meta">
        {loading ? (
          <>
            <Loader2 size={11} className="gate__spin" /> loading…
          </>
        ) : meta ? (
          <>
            <b>{meta.label}</b>
            <span>
              {new Date(meta.unix * 1000).toISOString().slice(11, 16)}Z
              {meta.units ? ` · ${meta.units}` : ""}
            </span>
          </>
        ) : (
          <span>{hits} product{hits === 1 ? "" : "s"}</span>
        )}
      </div>

      {frames.length > 1 && (
        <div className="mrms__frames">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={atIndex <= 0}
            aria-label="Previous frame"
          >
            <ChevronLeft size={13} />
          </button>
          <span className="mrms__frame">
            {shown
              ? new Date(shown.unix * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z"
              : "—"}
            {live && <em className="mrms__live">live</em>}
          </span>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={atIndex >= frames.length - 1}
            aria-label="Next frame"
          >
            <ChevronRight size={13} />
          </button>
          <button
            type="button"
            onClick={() => setFrameKey("")}
            disabled={live}
            aria-label="Jump to the newest frame"
            title="Newest"
          >
            <SkipForward size={12} />
          </button>
        </div>
      )}

      <div className="mrms__list">
        {groups.length === 0 && <p className="mrms__empty">Nothing matches “{q}”.</p>}
        {groups.map(([group, list]) => (
          <section key={group} className="mrms__group">
            <h4 className="mrms__grouphead">{group}</h4>
            {list.map((p) => (
              <button
                key={p.id}
                type="button"
                // Shown rather than hidden: somebody who knows MRMS has
                // rotation tracks should see that this region does not carry
                // them, not be left wondering where the group went.
                className={`mrms__item${product === p.id ? " is-on" : ""}${
                  p.available ? "" : " is-gone"
                }`}
                disabled={!p.available}
                title={p.available ? undefined : `Not published for ${regionLabel}`}
                onClick={() => setProduct(p.id)}
              >
                <span className="mrms__itemlabel">{p.label}</span>
                {p.available ? (
                  p.units && <span className="mrms__itemunit">{p.units}</span>
                ) : (
                  <span className="mrms__itemunit">n/a</span>
                )}
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
