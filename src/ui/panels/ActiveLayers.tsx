import { useRef, useState } from "react";
import { ChevronDown, GripVertical } from "lucide-react";

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
 *
 * A row is a layer, not a slider: switch, name, and the opacity as a number
 * that becomes a control while the pointer is on the row. Six fat sliders read
 * as six sliders; this reads as six layers -- and leaves room for the part a
 * layer list is actually for, which is saying what covers what. Rows are
 * dragged by the grip to reorder, top of the list being top of the map.
 *
 * It also folds. With several layers on, the rows push the product catalog
 * below the fold exactly when you are trying to reach it -- so the header is a
 * button, and the count stays visible while it is shut. The choice is kept
 * across sessions because it is a working preference, not a transient.
 */

const OPEN_KEY = "weatherts_actlayers_open";

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function ActiveLayers() {
  const layers = useAppStore((s) => s.layers);
  const layerOrder = useAppStore((s) => s.layerOrder);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);
  const setLayerVisibilityBatch = useAppStore((s) => s.setLayerVisibilityBatch);
  const setLayerOpacity = useAppStore((s) => s.setLayerOpacity);
  const setLayerOrder = useAppStore((s) => s.setLayerOrder);
  const moveLayer = useAppStore((s) => s.moveLayer);

  const [open, setOpen] = useState(readOpen);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /** Switched off from this list: kept on screen so it can go back on without
   *  hunting for its tile again. Cleared when the list is folded away. */
  const [justOff, setJustOff] = useState<string[]>([]);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next) setJustOff([]);
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      /* a preference that cannot be saved is still a preference for now */
    }
  };

  // Drawn top-down, which is the reverse of the bottom-to-top paint order:
  // what you see over everything else should read first.
  const stack = [...layerOrder].reverse().filter((id) => getLayerModule(id));
  const shown = stack.filter((id) => layers[id]?.visible || justOff.includes(id));
  const onCount = stack.filter((id) => layers[id]?.visible).length;

  if (shown.length === 0) return null;

  const setVisible = (id: string, visible: boolean) => {
    setLayerVisible(id, visible);
    setJustOff((prev) => (visible ? prev.filter((x) => x !== id) : prev.includes(id) ? prev : [...prev, id]));
  };

  const hideAll = () => {
    const on = stack.filter((id) => layers[id]?.visible);
    if (!on.length) return;
    setLayerVisibilityBatch(Object.fromEntries(on.map((id) => [id, false])));
    setJustOff(on);
  };

  /** Put `dragged` where `target` sits. The list is the paint order reversed,
   *  and splicing on the real order keeps both in step. */
  const drop = (dragged: string, target: string) => {
    if (dragged === target) return;
    const order = [...layerOrder];
    const from = order.indexOf(dragged);
    const to = order.indexOf(target);
    if (from < 0 || to < 0) return;
    order.splice(from, 1);
    order.splice(to, 0, dragged);
    setLayerOrder(order);
  };

  return (
    <div className={`actlayers${open ? "" : " is-shut"}`}>
      <div className="actlayers__bar">
        <button
          type="button"
          className="catrows__head actlayers__head"
          onClick={toggle}
          aria-expanded={open}
        >
          <ChevronDown size={12} className="actlayers__chev" />
          <span>On now · {onCount}</span>
        </button>
        {open && onCount > 0 && (
          <button type="button" className="actlayers__all" onClick={hideAll}>
            hide all
          </button>
        )}
      </div>

      {open &&
        shown.map((id) => {
          const module = getLayerModule(id)!;
          const { opacity, visible } = layers[id];
          const pct = Math.round(opacity * 100);
          return (
            <div
              key={id}
              ref={(el) => {
                rowRefs.current[id] = el;
              }}
              className={`actlayer${visible ? "" : " is-off"}${drag === id ? " is-dragging" : ""}${
                over === id && drag !== id ? " is-over" : ""
              }`}
              draggable
              onDragStart={(e) => {
                setDrag(id);
                e.dataTransfer.effectAllowed = "move";
                // Firefox refuses to start a drag without payload.
                e.dataTransfer.setData("text/plain", id);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOver(id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag) drop(drag, id);
                setDrag(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDrag(null);
                setOver(null);
              }}
            >
              <button
                type="button"
                className="actlayer__grip"
                aria-label={`Move ${module.name} in the stack`}
                title="Drag to reorder — or use the arrow keys"
                onKeyDown={(e) => {
                  // The pointer is not the only way to restack.
                  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                    e.preventDefault();
                    moveLayer(id, e.key === "ArrowUp" ? "up" : "down");
                    requestAnimationFrame(() => rowRefs.current[id]?.querySelector("button")?.focus());
                  }
                }}
              >
                <GripVertical size={12} />
              </button>

              <button
                type="button"
                role="switch"
                aria-checked={visible}
                className={`actlayer__switch${visible ? " is-on" : ""}`}
                title={visible ? `Switch off ${module.name}` : `Switch on ${module.name}`}
                onClick={() => setVisible(id, !visible)}
              >
                <span />
              </button>

              <span className="actlayer__name" title={module.name}>
                {module.name}
              </span>

              <input
                className="actlayer__range"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={opacity}
                disabled={!visible}
                aria-label={`${module.name} opacity`}
                onChange={(e) => setLayerOpacity(id, Number(e.target.value))}
              />
              <span className="actlayer__pct">{pct}%</span>
            </div>
          );
        })}
    </div>
  );
}
