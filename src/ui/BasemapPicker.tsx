import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Layers } from "lucide-react";

import { BASEMAPS, basemapInfo, type BasemapGroup } from "../map/basemaps";
import { useAppStore } from "../store/useAppStore";

const GROUP_ORDER: BasemapGroup[] = ["Vector", "Imagery", "Terrain"];

/**
 * Basemap chooser, floating at the map's top-left corner.
 *
 * On the map rather than in a settings panel because it is a *view* control:
 * swapping to imagery or a dark base is something you do while reading the map,
 * and reaching into a panel to do it breaks that. Top-left is the only free
 * corner — the product picker holds the right, `.measure` the centre.
 */
export function BasemapPicker() {
  const basemapId = useAppStore((s) => s.basemapId);
  const setBasemap = useAppStore((s) => s.setBasemap);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const groups = useMemo(
    () =>
      GROUP_ORDER.map(
        (g) => [g, BASEMAPS.filter((b) => b.group === g)] as [BasemapGroup, typeof BASEMAPS],
      ).filter(([, list]) => list.length > 0),
    [],
  );

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const current = basemapInfo(basemapId);

  return (
    <div className="bmpick" ref={root}>
      <button
        type="button"
        className={`bmpick__btn${open ? " is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`Basemap: ${current.label}`}
      >
        <Layers size={14} />
        <span>{current.label}</span>
        <ChevronDown size={13} />
      </button>

      {open && (
        <div className="bmpick__pop" role="menu">
          {groups.map(([group, list]) => (
            <div key={group} className="bmpick__group">
              <span className="bmpick__glabel">{group}</span>
              {list.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={b.id === basemapId}
                  className={`bmpick__item${b.id === basemapId ? " is-on" : ""}`}
                  onClick={() => {
                    setBasemap(b.id);
                    setOpen(false);
                  }}
                >
                  <span className="bmpick__tick">{b.id === basemapId && <Check size={11} />}</span>
                  <span className="bmpick__text">
                    <b>{b.label}</b>
                    <i>{b.hint}</i>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
