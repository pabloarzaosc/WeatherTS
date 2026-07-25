import { useCallback, useEffect, useRef, useState } from "react";

import { useLayoutStore, type DraggableId, type Offset } from "../store/useLayoutStore";

// Drag a HUD overlay around.
//
// What is stored is an OFFSET from wherever CSS put the element, never an
// absolute position. That keeps every responsive rule working: the product
// picker still tracks --map-right when the alert rail opens, the colour bar
// still sits at its pane's bottom edge, and the user's nudge is applied on top.
//
// Dragging is always live (no edit mode), so the handle must not swallow
// ordinary clicks: nothing moves until the pointer has travelled past a small
// threshold, and only then is the click suppressed.
//
// Two things the naive version got wrong:
//
//  * Nothing bounded the offset, so an element could be dragged clean off the
//    screen (or, for the colour bar, under its pane's `overflow: hidden`) with
//    no way back except resetting the whole layout. The offset is clamped to
//    keep the element inside its bounds.
//  * The offset went straight into a persisted store, so every pointermove
//    wrote the whole layout to localStorage synchronously -- ~100 blocking
//    writes a second on the one path that has to stay smooth. The live offset
//    is component state while dragging and is committed once, on release.

const THRESHOLD = 4;

export interface DragHandle {
  onPointerDown: (e: React.PointerEvent) => void;
  onClickCapture: (e: React.MouseEvent) => void;
}

export interface DragOptions {
  /**
   * CSS selector of the ancestor the element must stay inside, via closest().
   * Omitted, the element is kept inside the viewport. The colour bar passes
   * ".mappane" because its pane clips it.
   */
  boundsSelector?: string;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The offset range that keeps `el` fully inside its bounds.
 *
 * Measured from the element's position at offset zero, so the maths does not
 * drift as the element is dragged repeatedly.
 */
function offsetBounds(el: HTMLElement, current: Offset, boundsSelector?: string): Bounds {
  const rect = el.getBoundingClientRect();
  const baseLeft = rect.left - current.x;
  const baseTop = rect.top - current.y;

  const host = boundsSelector ? el.closest(boundsSelector) : null;
  const b = host
    ? host.getBoundingClientRect()
    : ({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight } as DOMRect);

  return {
    minX: b.left - baseLeft,
    maxX: b.right - rect.width - baseLeft,
    minY: b.top - baseTop,
    maxY: b.bottom - rect.height - baseTop,
  };
}

export function useDragOffset(
  id: DraggableId,
  options: DragOptions = {},
): {
  ref: React.RefObject<HTMLDivElement | null>;
  offset: Offset;
  dragging: boolean;
  handle: DragHandle;
  style: { transform: string };
} {
  const { boundsSelector } = options;
  const stored = useLayoutStore((s) => s.offsets[id]) ?? { x: 0, y: 0 };
  const setOffset = useLayoutStore((s) => s.setOffset);

  // The element that actually moves -- not the handle, which may be a child.
  const ref = useRef<HTMLDivElement | null>(null);
  // While dragging the offset lives here, so the persisted store (and
  // localStorage with it) is written once per drag rather than once per move.
  const [live, setLive] = useState<Offset | null>(null);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean } | null>(null);
  // Held so an unmount mid-drag can detach them; a pointerup that lands outside
  // the window would otherwise leave them attached for good.
  const detach = useRef<(() => void) | null>(null);

  useEffect(() => () => detach.current?.(), []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const el = ref.current;
      if (!el) return;

      const cur = useLayoutStore.getState().offsets[id] ?? { x: 0, y: 0 };
      const bounds = offsetBounds(el, cur, boundsSelector);
      start.current = { px: e.clientX, py: e.clientY, ox: cur.x, oy: cur.y, moved: false };

      const handleEl = e.currentTarget as HTMLElement;
      // Capture is a nicety (it keeps events coming if the pointer leaves the
      // handle); it throws for a pointer id the element never saw, so it must
      // not be on the path that installs the listeners.
      try {
        handleEl.setPointerCapture(e.pointerId);
      } catch {
        /* no capture -- the window listeners below still see everything */
      }

      let latest = { x: cur.x, y: cur.y };

      const move = (ev: PointerEvent) => {
        const s = start.current;
        if (!s) return;
        const dx = ev.clientX - s.px;
        const dy = ev.clientY - s.py;
        if (!s.moved && Math.abs(dx) + Math.abs(dy) < THRESHOLD) return;
        if (!s.moved) {
          s.moved = true;
          setDragging(true);
        }
        latest = {
          x: clamp(s.ox + dx, bounds.minX, bounds.maxX),
          y: clamp(s.oy + dy, bounds.minY, bounds.maxY),
        };
        setLive(latest);
      };

      const finish = (ev: PointerEvent) => {
        try {
          handleEl.releasePointerCapture(ev.pointerId);
        } catch {
          /* never captured */
        }
        cleanup();
        setDragging(false);
        // One write, on release. Clearing `live` in the same tick as the store
        // update lets React batch them, so the element never flashes back to
        // its old place.
        if (start.current?.moved) setOffset(id, latest);
        setLive(null);
        // `moved` stays set so the click that follows this pointerup can be
        // swallowed; the next pointerdown replaces the whole record.
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        detach.current = null;
      };

      // On window, not the element: a fast drag outruns the handle, and if
      // capture failed the element would simply stop receiving moves.
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      detach.current = cleanup;
    },
    [id, setOffset, boundsSelector],
  );

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (start.current?.moved) {
      e.stopPropagation();
      e.preventDefault();
      start.current.moved = false;
    }
  }, []);

  const offset = live ?? stored;
  return {
    ref,
    offset,
    dragging,
    handle: { onPointerDown, onClickCapture },
    style: { transform: `translate(${offset.x}px, ${offset.y}px)` },
  };
}
