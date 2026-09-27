import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, PanelLeftOpen, Tornado } from "lucide-react";

import { OUTLOOK_PRODUCTS, outlookOfModule, type OutlookProduct } from "../layers/modules/outlooksLayer";
import { useAppStore } from "../store/useAppStore";
import { useOutlookStore } from "../store/useOutlookStore";

const ALL_IDS = OUTLOOK_PRODUCTS.flatMap((p) => (p.variants.length ? p.variants.map((v) => p.moduleId(v.key)) : [p.moduleId("")]));

/**
 * The outlook on the map, and how to change it. One at a time: two outlooks'
 * colours over each other read as neither. Alerts stay as they are -- turning
 * an outlook on used to switch the warnings off.
 */
export function useOutlookSelection() {
  const layers = useAppStore((s) => s.layers);
  const setLayerVisibilityBatch = useAppStore((s) => s.setLayerVisibilityBatch);
  const activeId = ALL_IDS.find((id) => layers[id]?.visible) ?? null;
  const active = activeId ? outlookOfModule(activeId) : null;

  const show = (moduleId: string | null) => {
    const updates: Record<string, boolean> = {};
    for (const id of ALL_IDS) if (layers[id]?.visible || id === moduleId) updates[id] = id === moduleId;
    setLayerVisibilityBatch(updates);
  };
  /** A product, on the variant it had (the same day when switching Tornado ->
   *  Wind), else its first. */
  const pick = (product: OutlookProduct | null, variant?: string) => {
    if (!product) return show(null);
    const keys = product.variants.map((v) => v.key);
    const keep = variant ?? (active && keys.includes(active.variant) ? active.variant : keys[0] ?? "");
    show(product.moduleId(keep));
  };
  return { active, activeId, pick, show };
}

export function useOutlookGroups() {
  return useMemo(() => {
    const groups = new Map<string, OutlookProduct[]>();
    for (const p of OUTLOOK_PRODUCTS) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
    return [...groups.entries()];
  }, []);
}

/** Top-bar entry point: pick a product and its day; everything else is in the
 *  Outlooks panel of the Catalog. */
export function OutlookTopButton() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { active, pick } = useOutlookSelection();
  const groups = useOutlookGroups();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const variantLabel = active?.product.variants.find((v) => v.key === active.variant)?.label;

  return (
    <div className="outlook-picker" ref={wrapRef}>
      <button
        type="button"
        className={`outlook-mainbtn${active ? " is-active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        title="Outlooks"
        aria-label="Outlooks"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Tornado size={16} />
        <span className="outlook-mainbtn__label">{active ? active.product.label : "Outlooks"}</span>
        {active && variantLabel ? <span className="outlook-mainbtn__day">{variantLabel.replace("Day ", "D")}</span> : null}
        <ChevronDown size={14} className="outlook-mainbtn__chev" />
      </button>

      {open && (
        <div className="outlook-menu" role="menu">
          <div className="outlook-menu__head">
            <span>Choose outlook</span>
            {active && (
              <button type="button" className="outlook-menu__clear" onClick={() => pick(null)}>
                Clear
              </button>
            )}
          </div>

          <div className="outlook-menu__body">
            {groups.map(([group, products]) => (
              <section key={group} className="outlook-menu__group">
                <h3>{group}</h3>
                {products.map((product) => {
                  const on = active?.product.key === product.key;
                  return (
                    <button
                      key={product.key}
                      type="button"
                      className={`outlook-menu__item${on ? " is-active" : ""}`}
                      onClick={() => pick(product)}
                      title={product.description}
                      role="menuitemradio"
                      aria-checked={on}
                    >
                      <span>{product.label}</span>
                      {on && <Check size={13} />}
                    </button>
                  );
                })}
              </section>
            ))}
          </div>

          {active && active.product.variants.length > 1 && (
            <div className="outlook-menu__days" role="tablist" aria-label={`${active.product.label} day`}>
              {active.product.variants.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  className={`outlook-daytab${v.key === active.variant ? " is-active" : ""}`}
                  onClick={() => pick(active.product, v.key)}
                  role="tab"
                  aria-selected={v.key === active.variant}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            className="outlook-menu__more"
            onClick={() => {
              useOutlookStore.getState().openPanel();
              setOpen(false);
            }}
          >
            <PanelLeftOpen size={13} />
            <span>Outlooks panel: history, discussion, what changed</span>
          </button>
        </div>
      )}
    </div>
  );
}
