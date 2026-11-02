/**
 * Dragging a chip (or a product button from the picker) onto a pane
 * (panes-layout). Pointer events rather than HTML drag and drop: the hint has
 * to follow the pointer over WebGL maps, Esc must cancel, and a press that
 * does not move stays an ordinary click.
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import { usePaneStore, type PaneDragItem } from "../store/usePaneStore";
import { useNexradStore } from "../store/useNexradStore";
import { moveOrSwap, moveOverlay, showFamilyIn } from "./paneOps";
import { moveAnalysis } from "./paneWindows";

const START_PX = 6;

function paneAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const pane = el?.closest<HTMLElement>(".mappane[data-pane]");
  return pane?.dataset.pane ?? null;
}

/** What a drop of `item` on pane `to` does, or null when it does nothing. */
export function dropAction(item: PaneDragItem, to: string): "move" | "swap" | "show" | null {
  if (item.kind === "family") return "show";
  if (item.from === to) return null;
  if (item.kind === "overlay") return "move";
  if (item.kind === "analysis") return usePaneStore.getState().analysis[to] ? "swap" : "move";
  const target = useNexradStore.getState().paneRadar[to];
  if (!target) return null;
  return target.empty ? "move" : "swap";
}

function drop(item: PaneDragItem, to: string): void {
  if (item.kind === "family") showFamilyIn(to, item.family);
  else if (item.kind === "overlay") moveOverlay(item.overlay, item.from, to);
  else if (item.kind === "analysis") moveAnalysis(item.from, to);
  else moveOrSwap(item.from, to);
}

/**
 * Start watching a press for a drag. Call from onPointerDown; the click that a
 * press without movement makes is left alone, the click after a drag is eaten.
 */
export function beginPaneDrag(e: ReactPointerEvent, item: PaneDragItem): void {
  if (e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let dragging = false;
  const store = usePaneStore.getState();

  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < START_PX) return;
      dragging = true;
      document.body.classList.add("is-panedrag");
    }
    ev.preventDefault();
    store.setDrag({ item, x: ev.clientX, y: ev.clientY, over: paneAt(ev.clientX, ev.clientY) });
  };
  const end = (commit: boolean, ev?: PointerEvent) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    if (!dragging) return;
    document.body.classList.remove("is-panedrag");
    const over = ev ? paneAt(ev.clientX, ev.clientY) : null;
    usePaneStore.getState().setDrag(null);
    // The click this press would make lands wherever the pointer was let go.
    const eat = (c: MouseEvent) => {
      c.stopPropagation();
      c.preventDefault();
    };
    window.addEventListener("click", eat, true);
    setTimeout(() => window.removeEventListener("click", eat, true), 0);
    if (commit && over) drop(item, over);
  };
  const up = (ev: PointerEvent) => end(true, ev);
  const cancel = () => end(false);
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    end(false);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
}
