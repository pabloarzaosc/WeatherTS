import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeftRight, ChevronDown, ChevronsLeftRight, Loader2, X } from "lucide-react";

import { compareFamilies, setCompareFamily, stopCompare, swapSides } from "../lib/paneCompare";
import { useAppStore } from "../store/useAppStore";
import { clampSplit, useCompareStore } from "../store/useCompareStore";
import { useNexradStore } from "../store/useNexradStore";
import { RadarColorBar } from "./RadarColorBar";

/**
 * Compare two products in one pane (panes-compare): the divider, the name of
 * each half beside it, the right half's colour scale, and its product list.
 * The radar layer draws the two halves (nexradLayer: a scissor per side).
 *
 * The divider drags; a double-click centres it; clicked (focused), the arrow
 * keys move it (Shift for bigger steps) and Esc lets go.
 */
export function PaneCompare({ id }: { id: string }) {
  const slot = useCompareStore((s) => s.slots[id]);
  const view = useCompareStore((s) => s.views[id]);
  const selected = useCompareStore((s) => s.selected === id);
  const picking = useCompareStore((s) => s.picking === id);
  const host = useNexradStore((s) => s.paneRadar[id]);
  const site = useNexradStore((s) => s.site);
  const grids = useNexradStore((s) => s.grids);
  const catalog = useNexradStore((s) => s.catalog);
  const radarOn = useAppStore((s) => s.layers.nexrad?.visible ?? false);
  const ref = useRef<HTMLDivElement>(null);

  if (!slot || !host || host.empty || !radarOn || !site) return null;
  const famOf = (fid: string) => grids.find((f) => f.id === fid) ?? catalog.find((f) => f.id === fid);
  const left = famOf(host.family);
  const right = famOf(slot.family);
  const lElev = host.scan?.meta.elevation;
  const rElev = view?.scan?.meta.elevation;
  const name = (f: typeof left, fid: string, elev: number | null | undefined) =>
    `${f?.short ?? f?.label ?? fid}${elev != null ? ` ${elev.toFixed(1)}°` : ""}`;
  const split = slot.split;
  const pct = `${split * 100}%`;
  const store = useCompareStore.getState;

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    e.currentTarget.focus();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.classList.add("is-dragging");
    const move = (ev: PointerEvent) => store().setSplit(id, (ev.clientX - box.left) / (box.width || 1));
    const up = () => {
      el.classList.remove("is-dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      store().setSplit(id, clampSplit(split + (e.key === "ArrowLeft" ? -step : step)));
    } else if (e.key === "Home" || e.key === "End") {
      store().setSplit(id, e.key === "Home" ? 0 : 1);
    } else if (e.key === "Escape") {
      e.currentTarget.blur();
    } else return;
    // The timeline steps frames on the arrows anywhere: not while this moves.
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="pcmp" ref={ref}>
      <div
        className={`pcmp__div${selected ? " is-selected" : ""}`}
        style={{ left: pct }}
        tabIndex={0}
        role="separator"
        aria-orientation="vertical"
        aria-label="Compare divider"
        aria-valuemin={5}
        aria-valuemax={95}
        aria-valuenow={Math.round(split * 100)}
        title="Drag to move · double-click to centre · click, then the arrow keys"
        onPointerDown={startDrag}
        onDoubleClick={() => store().setSplit(id, 0.5)}
        onKeyDown={onKey}
        onFocus={() => store().select(id)}
        onBlur={() => store().select(null)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="pcmp__line" />
        <span className="pcmp__knob">
          <ChevronsLeftRight size={12} />
        </span>
      </div>
      <div className="pcmp__tags" style={{ left: pct }}>
        <span className="pcmp__tag pcmp__tag--l" title="This pane's product (left of the divider)">
          {name(left, host.family, lElev)}
        </span>
        <button
          type="button"
          className={`pcmp__tag pcmp__tag--r${picking ? " is-open" : ""}`}
          onClick={() => store().setPicking(picking ? null : id)}
          title="The compared product (right of the divider) · click to change"
        >
          {view?.loading && <Loader2 size={11} className="spin" />}
          {name(right, slot.family, rElev)}
          <ChevronDown size={11} />
        </button>
      </div>
      {view?.note && (
        <div className="pcmp__note" style={{ left: `calc(${pct} + (100% - ${pct}) / 2)` }}>
          {view.note}
        </div>
      )}
      {picking && <ComparePicker id={id} current={slot.family} hostFamily={host.family} />}
      <div className="mappane__cbar mappane__cbar--cmp">
        <RadarColorBar paneId={id} family={slot.family} meta={view?.scan?.meta ?? null} dragId="colorbarCompare" />
      </div>
    </div>
  );
}

/** The right half's product list (Change product). */
function ComparePicker({ id, current, hostFamily }: { id: string; current: string; hostFamily: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const grids = useNexradStore((s) => s.grids);
  const fams = compareFamilies().filter((f) => !f.unavailable);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t) || t?.closest?.(".pcmp__tag--r")) return;
      useCompareStore.getState().setPicking(null);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && useCompareStore.getState().setPicking(null);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, []);
  // As the product picker lists them: each moment once, then the derived ones.
  const groups: Array<{ title: string; list: typeof fams }> = [
    { title: "Products", list: fams.filter((f) => f.group !== "derived") },
    { title: "Derived", list: fams.filter((f) => f.group === "derived") },
  ].filter((g) => g.list.length);
  return (
    <div className="pcmp__pick" ref={ref} role="menu" onMouseDown={(e) => e.stopPropagation()}>
      <div className="pcmp__pickhead">
        <span>Compare with</span>
        <button type="button" onClick={() => swapSides(id)} title="Swap sides">
          <ArrowLeftRight size={12} />
        </button>
        <button type="button" onClick={() => stopCompare(id)} title="Stop comparing">
          <X size={13} />
        </button>
      </div>
      <div className="pcmp__picklist">
        {grids.some((f) => f.checking) && <div className="pcmp__reading">Reading this radar's products…</div>}
        {groups.map((g) => (
          <div key={g.title}>
            <div className="pcmp__group">{g.title}</div>
            {g.list.map((f) => (
              <button
                key={f.id}
                type="button"
                role="menuitemradio"
                aria-checked={f.id === current}
                className={`pcmp__opt${f.id === current ? " is-on" : ""}`}
                disabled={f.id === hostFamily}
                onClick={() => {
                  setCompareFamily(id, f.id);
                  useCompareStore.getState().setPicking(null);
                }}
              >
                <span>{f.label}</span>
                {f.source === "level2" && f.group !== "derived" && <i className="pcmp__l2">L2</i>}
                {f.short && <small>{f.short}</small>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
