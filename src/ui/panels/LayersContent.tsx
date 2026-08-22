import { useState } from "react";
import { ChevronRight, Eye, EyeOff } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { getLayerModules } from "../../layers/registry";
import { LAYER_CATEGORIES, type LayerModule } from "../../layers/types";

/**
 * The Layers panel — built entirely from the layer registry + store, so a
 * newly registered LayerModule appears here automatically.
 *
 * Categories are collapsed by default and open one at a time on click. With
 * every category expanded the list ran to dozens of rows of sliders, which is
 * a wall to scroll past to reach the one layer you came for; a category is now
 * a heading you open, and its own eye still switches the whole group without
 * expanding it.
 */
export function LayersContent() {
  const layers = useAppStore((s) => s.layers);
  const order = useAppStore((s) => s.layerOrder);
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const setOpacity = useAppStore((s) => s.setLayerOpacity);
  const moveLayer = useAppStore((s) => s.moveLayer);
  const setLayerVisibilityBatch = useAppStore((s) => s.setLayerVisibilityBatch);

  const modules = getLayerModules();
  const groups = LAYER_CATEGORIES.map((cat) => ({
    cat,
    items: modules
      .filter((m) => m.category === cat.id)
      .sort((a, b) => order.indexOf(b.id) - order.indexOf(a.id)),
  })).filter((g) => g.items.length > 0);

  // Several may be open at once: comparing two categories is common enough
  // that forcing one shut to read another would be its own annoyance.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const visibleCount = Object.values(layers).filter((l) => l.visible).length;

  return (
    <div className="content">
      <div className="content__hint">
        {visibleCount}/{modules.length} layers visible
      </div>

      {groups.map(({ cat, items }) => {
        const on = items.filter((m) => layers[m.id]?.visible).length;
        const allVisible = on === items.length;
        const isOpen = open.has(cat.id);

        return (
          <section key={cat.id} className={`cat${isOpen ? " is-open" : ""}`}>
            <div className="cat__head">
              <button
                type="button"
                className="cat__toggle"
                aria-expanded={isOpen}
                onClick={() => toggleOpen(cat.id)}
              >
                <ChevronRight size={14} className="cat__chev" />
                <span className="cat__name">{cat.label}</span>
                {/* How many are on, without having to open the category. */}
                <span className={`cat__count${on > 0 ? " is-lit" : ""}`}>
                  {on}/{items.length}
                </span>
              </button>
              <button
                type="button"
                className="cat__eye"
                aria-label={allVisible ? `Hide all ${cat.label}` : `Show all ${cat.label}`}
                aria-pressed={allVisible}
                onClick={() =>
                  setLayerVisibilityBatch(
                    Object.fromEntries(items.map((i) => [i.id, !allVisible])),
                  )
                }
              >
                {on > 0 ? <Eye size={15} /> : <EyeOff size={15} />}
              </button>
            </div>

            {isOpen && (
              <div className="cat__body">
                {items.map((module) => (
                  <LayerRow
                    key={module.id}
                    module={module}
                    state={layers[module.id]}
                    z={order.indexOf(module.id)}
                    topZ={order.length - 1}
                    onToggle={() => toggleLayer(module.id)}
                    onOpacity={(v) => setOpacity(module.id, v)}
                    onUp={() => moveLayer(module.id, "up")}
                    onDown={() => moveLayer(module.id, "down")}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function LayerRow({
  module,
  state,
  z,
  topZ,
  onToggle,
  onOpacity,
  onUp,
  onDown,
}: {
  module: LayerModule;
  state: { visible: boolean; opacity: number } | undefined;
  z: number;
  topZ: number;
  onToggle: () => void;
  onOpacity: (v: number) => void;
  onUp: () => void;
  onDown: () => void;
}) {
  const visible = state?.visible ?? false;
  const opacity = state?.opacity ?? 1;
  const pct = Math.round(opacity * 100);

  return (
    <div className={`lrow${visible ? " is-on" : ""}`}>
      <button
        type="button"
        className="lrow__eye"
        aria-label={visible ? "Hide layer" : "Show layer"}
        aria-pressed={visible}
        onClick={onToggle}
      >
        {visible ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>

      <div className="lrow__main">
        <div className="lrow__top">
          <span className="lrow__name" title={module.description ?? module.name}>
            {module.name}
          </span>
          {/* Opacity and z-order only mean anything for a layer being drawn,
              so they stay out of the way until it is switched on. */}
          {visible && <span className="lrow__pct">{pct}%</span>}
        </div>

        {visible && (
          <>
            <input
              className="lrow__slider"
              type="range"
              min={0}
              max={100}
              value={pct}
              onChange={(e) => onOpacity(Number(e.target.value) / 100)}
              aria-label={`${module.name} opacity`}
            />
            <div className="lrow__foot">
              <span className="lrow__src">{module.source}</span>
              <span className="lrow__order">
                <button
                  type="button"
                  aria-label="Move up"
                  disabled={z >= topZ}
                  onClick={onUp}
                >
                  ▲
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  disabled={z <= 0}
                  onClick={onDown}
                >
                  ▼
                </button>
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
