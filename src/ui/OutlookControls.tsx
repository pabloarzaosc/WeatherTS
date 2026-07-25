import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Tornado } from "lucide-react";

import { getLayerModules } from "../layers/registry";
import type { LayerModule } from "../layers/types";
import { useAppStore } from "../store/useAppStore";

const OUTLOOK_MODULES = getLayerModules().filter((module) => module.category === "outlooks");

interface OutlookOption {
  module: LayerModule;
  group: string;
  label: string;
  productKey: string;
  day?: number;
}

const LABELS: Record<string, string> = {
  categorical: "Categorical",
  tornado: "Tornado",
  wind: "Wind",
  hail: "Hail",
  probabilistic: "Probabilistic",
};

function title(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function optionFromModule(module: LayerModule): OutlookOption {
  const spc = /^spc-d([1-5])-(.+)$/.exec(module.id);
  if (spc) {
    const day = Number(spc[1]);
    const kind = spc[2];
    return {
      module,
      group: "SPC Convective/Severe Weather",
      label: LABELS[kind] ?? title(kind),
      productKey: `spc-${kind}`,
      day,
    };
  }

  const wpc = /^wpc-ero-d([123])$/.exec(module.id);
  if (wpc) {
    return {
      module,
      group: "WPC Excessive Rainfall",
      label: "Excessive Rainfall",
      productKey: "wpc-ero",
      day: Number(wpc[1]),
    };
  }

  if (module.id.startsWith("cpc-")) {
    return {
      module,
      group: "CPC Outlooks",
      label: module.name.replace(/^CPC\s+/, ""),
      productKey: module.id,
    };
  }

  if (module.id.startsWith("nadocast-")) {
    return {
      module,
      group: "NadoCast",
      label: module.name.replace(/^NadoCast\s+/, ""),
      productKey: module.id,
    };
  }

  return { module, group: "Outlooks", label: module.name, productKey: module.id };
}

const OUTLOOK_OPTIONS = OUTLOOK_MODULES.map(optionFromModule);

function useOutlookActions() {
  const layers = useAppStore((s) => s.layers);
  const setLayerVisibilityBatch = useAppStore((s) => s.setLayerVisibilityBatch);

  const activeOption = OUTLOOK_OPTIONS.find((option) => layers[option.module.id]?.visible) ?? null;
  const activeIds = OUTLOOK_OPTIONS.filter((option) => layers[option.module.id]?.visible).map((option) => option.module.id);

  const activateId = (id: string | null) => {
    const updates: Record<string, boolean> = { "nws-alerts": false };
    for (const module of OUTLOOK_MODULES) updates[module.id] = false;
    if (id) updates[id] = true;
    setLayerVisibilityBatch(updates);
  };

  const activateProduct = (productKey: string | null) => {
    if (!productKey) {
      activateId(null);
      return;
    }
    const variants = OUTLOOK_OPTIONS.filter((option) => option.productKey === productKey);
    const currentDay = activeOption?.productKey === productKey ? activeOption.day : undefined;
    const id =
      variants.find((option) => option.day === currentDay)?.module.id ??
      variants.find((option) => option.day === 1)?.module.id ??
      variants[0]?.module.id ??
      null;
    activateId(id);
  };

  return { layers, activeIds, activeOption, activateId, activateProduct };
}

function useGroupedProducts(layers: Record<string, { visible: boolean; opacity: number }>) {
  return useMemo(() => {
    const seen = new Set<string>();
    const products = OUTLOOK_OPTIONS.filter((option) => {
      if (seen.has(option.productKey)) return false;
      seen.add(option.productKey);
      return true;
    });
    const grouped = new Map<string, OutlookOption[]>();
    for (const product of products) {
      grouped.set(product.group, [...(grouped.get(product.group) ?? []), product]);
    }
    return Array.from(grouped.entries()).map(([group, options]) => ({
      group,
      options: options.map((option) => ({
        ...option,
        active: OUTLOOK_OPTIONS.some((candidate) => candidate.productKey === option.productKey && layers[candidate.module.id]?.visible),
      })),
    }));
  }, [layers]);
}

/** Single top-bar entry point for outlooks: a button that reveals a gray dropdown
 *  to pick the product and its valid day variants. Nothing floats over
 *  the map — the panel only exists while the button is pressed open. */
export function OutlookTopButton() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { layers, activeIds, activeOption, activateId, activateProduct } = useOutlookActions();
  const groups = useGroupedProducts(layers);

  // Dismiss on outside click or Escape — it is a transient top-bar popover.
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

  const isActive = activeIds.length > 0 && Boolean(activeOption);
  const dayVariants = activeOption
    ? OUTLOOK_OPTIONS.filter((option) => option.productKey === activeOption.productKey && option.day).sort(
        (a, b) => (a.day ?? 0) - (b.day ?? 0),
      )
    : [];

  return (
    <div className="outlook-picker" ref={wrapRef}>
      <button
        type="button"
        className={`outlook-mainbtn${isActive ? " is-active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        title="Outlooks"
        aria-label="Outlooks"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Tornado size={16} />
        <span className="outlook-mainbtn__label">{isActive && activeOption ? activeOption.label : "Outlooks"}</span>
        {isActive && activeOption?.day ? <span className="outlook-mainbtn__day">D{activeOption.day}</span> : null}
        <ChevronDown size={14} className="outlook-mainbtn__chev" />
      </button>

      {open && (
        <div className="outlook-menu" role="menu">
          <div className="outlook-menu__head">
            <span>Choose outlook</span>
            {isActive && (
              <button type="button" className="outlook-menu__clear" onClick={() => activateId(null)}>
                Clear
              </button>
            )}
          </div>

          <div className="outlook-menu__body">
            {groups.map(({ group, options }) => (
              <section key={group} className="outlook-menu__group">
                <h3>{group}</h3>
                {options.map((option) => (
                  <button
                    key={option.productKey}
                    type="button"
                    className={`outlook-menu__item${option.active ? " is-active" : ""}`}
                    onClick={() => activateProduct(option.productKey)}
                    title={option.module.description ?? option.module.name}
                    role="menuitemradio"
                    aria-checked={option.active}
                  >
                    <span>{option.label}</span>
                    {option.active && <Check size={13} />}
                  </button>
                ))}
              </section>
            ))}
          </div>

          {dayVariants.length > 1 && activeOption && (
            <div className="outlook-menu__days" role="tablist" aria-label={`${activeOption.label} day`}>
              <span className="outlook-menu__days-label">Day</span>
              {dayVariants.map((option) => (
                <button
                  key={option.module.id}
                  type="button"
                  className={`outlook-daytab${option.module.id === activeOption.module.id ? " is-active" : ""}`}
                  onClick={() => activateId(option.module.id)}
                  role="tab"
                  aria-selected={option.module.id === activeOption.module.id}
                >
                  Day {option.day}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
