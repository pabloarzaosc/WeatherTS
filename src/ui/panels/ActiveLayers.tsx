import { Power } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { getLayerModule } from "../../layers/registry";

/**
 * What is switched on right now, under the category tiles.
 *
 * The tiles are how a product gets turned on; this is what happens next.
 * Without it, tuning a layer you just enabled means leaving the Catalog for the
 * Layers tab, and the space under the tiles sat empty. It grows with what you
 * have on and disappears entirely when nothing is, so it never costs room it
 * has not earned.
 */
export function ActiveLayers() {
  const layers = useAppStore((s) => s.layers);
  const layerOrder = useAppStore((s) => s.layerOrder);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);
  const setLayerOpacity = useAppStore((s) => s.setLayerOpacity);

  // Drawn top-down, which is the reverse of the bottom-to-top paint order:
  // what you see over everything else should read first.
  const active = [...layerOrder]
    .reverse()
    .filter((id) => layers[id]?.visible && getLayerModule(id));

  if (active.length === 0) return null;

  return (
    <div className="actlayers">
      <div className="catrows__head">
        On now · {active.length}
      </div>
      {active.map((id) => {
        const module = getLayerModule(id)!;
        const opacity = layers[id].opacity;
        return (
          <div className="actlayer" key={id}>
            <button
              type="button"
              className="catrow__star"
              title={`Switch off ${module.name}`}
              onClick={() => setLayerVisible(id, false)}
            >
              <Power size={13} />
            </button>
            <div className="actlayer__body">
              <b>{module.name}</b>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={opacity}
                aria-label={`${module.name} opacity`}
                onChange={(e) => setLayerOpacity(id, Number(e.target.value))}
              />
            </div>
            <span className="catrow__state">{Math.round(opacity * 100)}%</span>
          </div>
        );
      })}
    </div>
  );
}
