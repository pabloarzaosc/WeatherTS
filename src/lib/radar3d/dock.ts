// Where the 3D view and its map bar sit when the map is split into panes.
//
// With one pane the CSS split layout applies: the view takes the right 58% of
// the map area and the bar sits under the left part. With several, the right
// 58% of the whole area covered the second pane, so the view docks over the
// panes other than the focused one (where the box is drawn) and the bar sits
// at the foot of the focused pane.

import { useEffect, useState } from "react";

import { allMaps, getMap, subscribeMaps } from "../../map/mapInstance";

export interface DockRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Below this width the map bar shows icons only. */
export const COMPACT_BAR_PX = 600;

function union(rs: DockRect[]): DockRect {
  const l = Math.min(...rs.map((r) => r.left));
  const t = Math.min(...rs.map((r) => r.top));
  const r = Math.max(...rs.map((x) => x.left + x.width));
  const b = Math.max(...rs.map((x) => x.top + x.height));
  return { left: l, top: t, width: r - l, height: b - t };
}

const rectOf = (el: HTMLElement): DockRect => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

/** The focused pane and, with more than one, the area the 3D view takes
 *  (viewport px): the other panes when they make a rectangle, else the half
 *  of the map area away from the focused pane. */
export function measureDock(): { focus: DockRect | null; view: DockRect | null } {
  const focusMap = getMap();
  const focus = focusMap ? rectOf(focusMap.getContainer()) : null;
  const maps = allMaps();
  if (!focus || maps.length < 2) return { focus, view: null };
  const others = maps
    .filter((m) => m !== focusMap)
    .map((m) => rectOf(m.getContainer()))
    .filter((r) => r.width > 0 && r.height > 0);
  if (!others.length) return { focus, view: null };
  const u = union(others);
  const area = others.reduce((a, r) => a + r.width * r.height, 0);
  if (Math.abs(u.width * u.height - area) <= 0.03 * area) return { focus, view: u };
  const all = union([focus, ...others]);
  const mid = all.left + all.width / 2;
  const view =
    focus.left + focus.width / 2 < mid
      ? { left: mid, top: all.top, width: all.left + all.width - mid, height: all.height }
      : { left: all.left, top: all.top, width: mid - all.left, height: all.height };
  return { focus, view };
}

const same = (a: DockRect | null, b: DockRect | null) =>
  a === b ||
  (!!a &&
    !!b &&
    Math.abs(a.left - b.left) < 1 &&
    Math.abs(a.top - b.top) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1);

/** measureDock, kept current across pane changes, focus and resizes. */
export function useDock(): { focus: DockRect | null; view: DockRect | null } {
  const [dock, setDock] = useState(measureDock);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const d = measureDock();
        setDock((p) => (same(p.focus, d.focus) && same(p.view, d.view) ? p : d));
      });
    };
    update();
    const off = subscribeMaps(update);
    window.addEventListener("resize", update);
    const ro = new ResizeObserver(update);
    for (const m of allMaps()) ro.observe(m.getContainer());
    return () => {
      cancelAnimationFrame(raf);
      off();
      window.removeEventListener("resize", update);
      ro.disconnect();
    };
  }, []);
  return dock;
}
