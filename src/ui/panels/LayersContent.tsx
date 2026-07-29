import { ChevronUp, ChevronDown, Eye, EyeOff } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { getLayerModules } from "../../layers/registry";
import { LAYER_CATEGORIES, type LayerModule } from "../../layers/types";

/** The Layers panel — built entirely from the layer registry + store, so a
 *  newly registered LayerModule appears here automatically. */
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

  const visibleCount = Object.values(layers).filter((l) => l.visible).length;

  return (
    <div className="content">
      <div className="content__hint">
        {visibleCount}/{modules.length} layers visible
      </div>
      {groups.map(({ cat, items }) => {
        const allVisible = items.every((module) => layers[module.id]?.visible);
        const someVisible = items.some((module) => layers[module.id]?.visible);
        const toggleCategory = () => {
          const updates: Record<string, boolean> = {};
          const targetState = !allVisible;
          for (const item of items) {
            updates[item.id] = targetState;
          }
          setLayerVisibilityBatch(updates);
        };

        return (
          <section key={cat.id} className="group">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingRight: 8 }}>
              <h3 className="group__label">{cat.label}</h3>
              <button
                type="button"
                className="row__eye"
                aria-label={allVisible ? `Hide ${cat.label} layers` : `Show ${cat.label} layers`}
                aria-pressed={allVisible}
                onClick={toggleCategory}
                style={{ opacity: someVisible && !allVisible ? 0.5 : 1 }}
              >
                {allVisible || someVisible ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
            </div>
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
    <div className={`row${visible ? "" : " is-off"}`}>
      <button
        type="button"
        className="row__eye"
        aria-label={visible ? "Hide layer" : "Show layer"}
        aria-pressed={visible}
        onClick={onToggle}
      >
        {visible ? <Eye size={16} /> : <EyeOff size={16} />}
      </button>

      <div className="row__main">
        <div className="row__top">
          <span className="row__name" title={module.description ?? module.name}>
            {module.name}
          </span>
          <span className="row__pct">{pct}%</span>
        </div>
        <input
          className="row__slider"
          type="range"
          min={0}
          max={100}
          value={pct}
          disabled={!visible}
          onChange={(e) => onOpacity(Number(e.target.value) / 100)}
          aria-label={`${module.name} opacity`}
        />
        <span className="row__src">{module.source}</span>
      </div>

      <div className="row__order">
        <button
          type="button"
          className="row__arrow"
          aria-label="Move up"
          disabled={z >= topZ}
          onClick={onUp}
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          className="row__arrow"
          aria-label="Move down"
          disabled={z <= 0}
          onClick={onDown}
        >
          <ChevronDown size={14} />
        </button>
      </div>
    </div>
  );
}
