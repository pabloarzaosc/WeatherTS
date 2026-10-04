import { useState, useSyncExternalStore } from "react";
import { ChartArea, ChevronDown, Radar } from "lucide-react";

import { getActivePaneId, subscribeMaps } from "../map/mapInstance";
import { useDragOffset } from "../lib/useDragOffset";
import { useNexradStore } from "../store/useNexradStore";
import { useXsectStore } from "../store/useXsectStore";
import type { ProductFamily } from "../lib/nexrad";

// The radar product picker, pinned to the map's top-right. It drives the FOCUSED
// pane, like every other getMap()-based tool.
//
// One flat list, not two Level 2 / Level 3 grids: every product appears once,
// already on its best source. Level II is used only for the handful of moments
// where it truly wins (CC, ZDR, SW, PHI, CFP); those carry an "L2" tag so it's
// clear they're the single-snapshot, higher-res source. Everything else is
// Level III, with the animated loop and the archive.

function ProductItem({
  f,
  on,
  activeTilt,
  tiltsKnown,
  siteName,
  onPick,
  onTilt,
}: {
  f: ProductFamily;
  on: boolean;
  activeTilt: string | null;
  /** The selected radar's tilts have been checked (or could not be). */
  tiltsKnown: boolean;
  siteName: string;
  onPick: (id: string) => void;
  onTilt: (t: string) => void;
}) {
  const tilts = f.tilts.filter((t) => t.tilt !== null);
  return (
    <div className={`rpp__item${on ? " is-on" : ""}${f.unavailable ? " is-unavailable" : ""}`}>
      <button
        type="button"
        className="rpp__btn"
        onClick={() => onPick(f.id)}
        disabled={f.unavailable}
        title={f.unavailable ? `${siteName} is not publishing ${f.label} right now` : undefined}
      >
        <span className="rpp__code">{f.short ?? f.id}</span>
        <span className="rpp__label">{f.label}</span>
        {f.source === "level2" && <span className="rpp__l2">L2</span>}
        {f.units && <span className="rpp__units">{f.units}</span>}
      </button>
      {/* Elevations only for the selected product -- showing every tilt of every
          product at once was the wall of tiny controls this replaces. */}
      {on && (!tiltsKnown || f.checking) && (
        <div className="rpp__tilts rpp__tilts--checking" aria-live="polite">
          checking {siteName}'s tilts…
        </div>
      )}
      {on && tiltsKnown && !f.checking && tilts.length > 1 && (
        <div className="rpp__tilts" role="group" aria-label="Elevation">
          {tilts.map((t) => (
            <button
              key={t.code}
              type="button"
              className={`rpp__tilt${t.tilt === activeTilt ? " is-on" : ""}${
                t.superRes ? " is-sr" : ""
              }`}
              onClick={() => onTilt(t.tilt!)}
              title={
                t.lowCut
                  ? `${t.elev}° — this radar's lowest cut, from Level II (slower to load)`
                  : t.source === "level2" && f.source !== "level2"
                    ? `${t.elev}° — only in Level II (slower to load)`
                    : t.superRes
                      ? `${t.elev}° — super-res (0.5°)`
                      : `${t.elev}°`
              }
            >
              {t.elev?.toFixed(1)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function RadarProductPanel() {
  const grids = useNexradStore((s) => s.grids);
  const site = useNexradStore((s) => s.site);
  const family = useNexradStore((s) => s.family);
  const tilt = useNexradStore((s) => s.tilt);
  // The object reference, not Object.keys(): a selector returning a fresh array
  // every call makes useSyncExternalStore see a new snapshot each render and
  // loop forever. Derive the keys below instead.
  const paneRadar = useNexradStore((s) => s.paneRadar);
  const activePane = useSyncExternalStore(subscribeMaps, getActivePaneId);
  const setFamily = useNexradStore((s) => s.setFamily);
  const setTilt = useNexradStore((s) => s.setTilt);
  const availabilityState = useNexradStore((s) => s.availabilityState);
  const siteName = useNexradStore((s) => s.sites.find((x) => x.id === s.site)?.icao ?? (s.site ? `K${s.site}` : "This radar"));
  // No alert-list dodge needed any more: the rail is a docked column, so
  // --map-right already keeps this panel clear of it.
  const [open, setOpen] = useState(true);
  const drag = useDragOffset("products");
  const xsDrawing = useXsectStore((s) => s.drawing);
  const xsOn = useXsectStore((s) => s.a !== null);

  if (!site) return null;
  if (!grids.length) return null;

  const current = grids.find((f) => f.id === family)?.label ?? family;
  const paneIds = Object.keys(paneRadar).sort();
  const paneCount = paneIds.length;
  // Panes are keyed "pane-0", "pane-1", ... and rendered in that order, so the
  // index in the sorted key list is the position the user sees on screen.
  const paneNumber = activePane ? paneIds.indexOf(activePane) + 1 : 1;

  return (
    <div
      ref={drag.ref}
      className={`rpp${open ? "" : " rpp--collapsed"}${drag.dragging ? " is-dragging" : ""}`}
      style={drag.style}
    >
      {/* The header doubles as the drag handle. useDragOffset only starts moving
          past a few pixels, so the collapse click still works. */}
      <button
        type="button"
        className="rpp__head hud-grip"
        onClick={() => setOpen((v) => !v)}
        {...drag.handle}
      >
        <Radar size={13} />
        <span className="rpp__headname">{current}</span>
        <ChevronDown size={14} className="rpp__chev" />
      </button>
      {/* With one pane "the picker edits the map" is obvious. With several it is
          not, and picking blind was the complaint -- so name the target. */}
      {paneCount > 1 && (
        <div className="rpp__target">
          editing <b>Pane {paneNumber}</b> of {paneCount}
        </div>
      )}
      {open && (
        <div className="rpp__body">
          {grids.map((f) => (
            <ProductItem
              key={f.id}
              f={f}
              on={f.id === family}
              activeTilt={tilt}
              tiltsKnown={availabilityState !== "loading"}
              siteName={siteName}
              onPick={setFamily}
              onTilt={setTilt}
            />
          ))}
        </div>
      )}
      {/* A vertical slice through the whole volume, along a line drawn on the
          map: the one radar tool that is about height, not the map. */}
      <button
        type="button"
        className={`rpp__xsect${xsDrawing || xsOn ? " is-on" : ""}`}
        onClick={() => {
          const xs = useXsectStore.getState();
          if (xs.drawing) xs.cancelDrawing();
          else xs.startDrawing();
        }}
        title="Draw a line on the map: a vertical slice through every tilt under it (Level II)"
        aria-pressed={xsDrawing}
      >
        <ChartArea size={13} />
        <span>{xsDrawing ? "Click two points on the map… (Esc)" : xsOn ? "New cross section" : "Cross section"}</span>
      </button>
    </div>
  );
}
