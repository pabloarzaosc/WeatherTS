import { Fragment, useEffect, useState, useSyncExternalStore } from "react";
import { Box, ChartArea, ChevronDown, Radar } from "lucide-react";

import { getActivePaneId, subscribeMaps } from "../map/mapInstance";
import { useDragOffset } from "../lib/useDragOffset";
import { useNexradStore } from "../store/useNexradStore";
import { useXsectStore } from "../store/useXsectStore";
import { useRadar3DStore } from "../store/useRadar3DStore";
import { currentFrame } from "../lib/radar3d/selection";
import type { ProductFamily } from "../lib/nexrad";
import { productDescription } from "../lib/productDescriptions";
import { keyForFamily } from "../lib/radarKeys";
import { cutOf } from "../lib/radarFrames";
import { useSetting } from "../settings/useSettingsStore";
import { beginPaneDrag } from "../lib/paneDrag";
import { paneLetter } from "../store/usePaneStore";
import { useFeature } from "../store/useFeatureStore";

/** Hover text for a product button: name, key, what it shows. */
function productHint(f: ProductFamily, tdwr: boolean): string {
  const key = keyForFamily(f.id);
  const desc = productDescription(f.id, f.kind, tdwr);
  return `${f.label}${key ? ` (key ${key})` : ""}${desc ? `
${desc}` : ""}`;
}

const DERIVED_OPEN_KEY = "weatherts-rpp-derived";
function readDerivedOpen(): boolean {
  try {
    return localStorage.getItem(DERIVED_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

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
  tdwr,
  onPick,
  onTilt,
  cut,
  onCut,
}: {
  f: ProductFamily;
  on: boolean;
  activeTilt: string | null;
  /** The selected radar's tilts have been checked (or could not be). */
  tiltsKnown: boolean;
  siteName: string;
  tdwr: boolean;
  onPick: (id: string) => void;
  onTilt: (t: string) => void;
  /** "Expand SAILS cuts" off: which scan of the active tilt is shown, of how
   *  many this volume has; the badge steps to the next. */
  cut?: { rep: number; of: number } | null;
  onCut?: () => void;
}) {
  const tilts = f.tilts.filter((t) => t.tilt !== null);
  return (
    <div className={`rpp__item${on ? " is-on" : ""}${f.unavailable ? " is-unavailable" : ""}`}>
      <button
        type="button"
        className="rpp__btn"
        onClick={() => onPick(f.id)}
        // Drag it onto any pane to show it there (panes-layout).
        onPointerDown={(e) => !f.unavailable && beginPaneDrag(e, { kind: "family", family: f.id, label: f.label })}
        disabled={f.unavailable}
        title={f.unavailable ? `${siteName} is not publishing ${f.label} right now` : `${productHint(f, tdwr)}
Drag onto a pane to show it there`}
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
            <Fragment key={t.code}>
            <button
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
            {t.tilt === activeTilt && cut && (
              <button
                type="button"
                className="rpp__cut"
                onClick={onCut}
                title={`SAILS / MRLE: ${t.elev?.toFixed(1)}° is scanned ${cut.of} times in this volume. Showing scan ${cut.rep}; click for the next.`}
                aria-label={`Scan ${cut.rep} of ${cut.of} at this tilt, next`}
              >
                {cut.rep}/{cut.of}
              </button>
            )}
            </Fragment>
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
  // SAILS / MRLE scans of the tilt, stepped from a badge when not expanded.
  const expandSails = useSetting<boolean>("radar.expandSails");
  const frameNow = useNexradStore((s) => s.scans[s.index]);
  const sailsRep = useNexradStore((s) => s.sailsRep);
  const setSailsRep = useNexradStore((s) => s.setSailsRep);
  const l2Slot = useNexradStore((s) => (s.product.startsWith("L2") ? s.tilt : null));
  const cut = expandSails ? null : cutOf(frameNow, l2Slot, sailsRep);
  // The object reference, not Object.keys(): a selector returning a fresh array
  // every call makes useSyncExternalStore see a new snapshot each render and
  // loop forever. Derive the keys below instead.
  const paneRadar = useNexradStore((s) => s.paneRadar);
  const activePane = useSyncExternalStore(subscribeMaps, getActivePaneId);
  const setFamily = useNexradStore((s) => s.setFamily);
  const setTilt = useNexradStore((s) => s.setTilt);
  const availabilityState = useNexradStore((s) => s.availabilityState);
  const siteName = useNexradStore((s) => s.sites.find((x) => x.id === s.site)?.icao ?? (s.site ? `K${s.site}` : "This radar"));
  // An airport radar's list is its own, and the volume tools read NEXRAD volumes.
  const tdwr = useNexradStore((s) => s.sites.some((x) => x.id === s.site && x.type === "TDWR"));
  // No alert-list dodge needed any more: the rail is a docked column, so
  // --map-right already keeps this panel clear of it.
  const [open, setOpen] = useState(true);
  // A pane's product chip asks for the list (panes-layout).
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("weatherts:products-open", show);
    return () => window.removeEventListener("weatherts:products-open", show);
  }, []);
  const drag = useDragOffset("products");
  const xsDrawing = useXsectStore((s) => s.drawing);
  const xsOn = useXsectStore((s) => s.a !== null);
  const v3dOpen = useRadar3DStore((s) => s.open);
  // Settings > Features (ux-shell).
  const xsFeature = useFeature("xsect");
  const v3dFeature = useFeature("radar3d");
  // The Derived group folds; its state outlives the session.
  const [derivedOpen, setDerivedOpenState] = useState(readDerivedOpen);
  const setDerivedOpen = (v: boolean) => {
    setDerivedOpenState(v);
    try {
      localStorage.setItem(DERIVED_OPEN_KEY, v ? "1" : "0");
    } catch {
      /* private window: the fold just is not remembered */
    }
  };
  // Keep the picked product in view: a key press can pick one below the fold.
  // The list is held as state (a callback ref), not a ref object: it unmounts
  // whenever the product list is reloaded, and a fresh one must scroll too.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = body?.querySelector<HTMLElement>(".rpp__item.is-on");
    if (!body || !el) return;
    const b = body.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    // The description line of its group comes along when it fits.
    const desc = el.parentElement?.querySelector<HTMLElement>(":scope > .rpp__desc");
    const bottom = desc ? Math.min(desc.getBoundingClientRect().bottom, r.top + b.height - 16) : r.bottom;
    if (r.top < b.top) body.scrollTop -= b.top - r.top + 8;
    else if (bottom > b.bottom) body.scrollTop += bottom - b.bottom + 6;
  }, [body, family, tilt, derivedOpen]);

  if (!site) return null;
  if (!grids.length) return null;

  const current = grids.find((f) => f.id === family)?.label ?? family;
  // Only what this radar has (see below); the product on screen stays listed.
  const shown = grids.filter((f) => !f.unavailable || f.id === family);
  const mainList = shown.filter((f) => f.group !== "derived");
  const derivedList = shown.filter((f) => f.group === "derived");
  const picked = grids.find((f) => f.id === family);
  const pickedDesc = picked ? productDescription(picked.id, picked.kind, tdwr) : null;
  // The picked product's description sits right under its own row (at the
  // end of the group it read as the last row's).
  const item = (f: ProductFamily) => (
    <Fragment key={f.id}>
      <ProductItem
        f={f}
        on={f.id === family}
        activeTilt={tilt}
        tiltsKnown={availabilityState !== "loading"}
        siteName={siteName}
        tdwr={tdwr}
        onPick={setFamily}
        onTilt={setTilt}
        cut={f.id === family ? cut : null}
        onCut={() => cut && setSailsRep(cut.rep >= cut.of ? 1 : cut.rep + 1)}
      />
      {f.id === family && pickedDesc && <div className="rpp__desc">{pickedDesc}</div>}
    </Fragment>
  );
  const paneIds = Object.keys(paneRadar).sort();
  const paneCount = paneIds.length;

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
          editing <b>Pane {activePane ? paneLetter(activePane) : "A"}</b> of {paneCount}
        </div>
      )}
      {open && (
        <div className="rpp__body" ref={setBody}>
          {/* Only what this radar has: a NEXRAD site lists no Unfiltered
              Reflectivity, a Brazilian volume no Level III products. Greyed-out
              rows for what it lacks made the list read as broken. The product
              on screen stays listed while the store moves off it. */}
          {mainList.map(item)}
          {/* Products computed here from the Level II volume
              (backend/radar_derived.py). Folded, only the one on screen stays. */}
          {derivedList.length > 0 && (
            <div className={`rpp__group${derivedOpen ? " is-open" : ""}`}>
              <button
                type="button"
                className="rpp__grouphead"
                onClick={() => setDerivedOpen(!derivedOpen)}
                aria-expanded={derivedOpen}
                title="Computed from each Level II volume: composite, echo tops, VIL, VIL density, rotation, debris score and SRV at every tilt"
              >
                <ChevronDown size={12} className="rpp__groupchev" />
                <span>Derived</span>
                <small>from Level II</small>
              </button>
              {(derivedOpen ? derivedList : derivedList.filter((f) => f.id === family)).map(item)}
            </div>
          )}
        </div>
      )}
      {tdwr && (xsFeature || v3dFeature) && (
        <div className="rpp__tdwrnote" title="These tools read a NEXRAD radar's Level II volume">
          Cross section and 3D view: NEXRAD radars only
        </div>
      )}
      {/* A vertical slice through the whole volume, along a line drawn on the
          map: the one radar tool that is about height, not the map. */}
      {!tdwr && (xsFeature || v3dFeature) && (
      <div className="rpp__tools">
      {xsFeature && (
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
      )}
      {/* The whole volume in 3D, over a box drawn on the map. */}
      {v3dFeature && (
      <button
        type="button"
        className={`rpp__xsect${v3dOpen ? " is-on" : ""}`}
        onClick={() => {
          const v = useRadar3DStore.getState();
          if (v.open) v.close();
          else if (site) v.openView({ site, ...currentFrame(), draw: "box" });
        }}
        title="The radar volume in 3D: drag a box on the map (Level II)"
        aria-pressed={v3dOpen}
      >
        <Box size={13} />
        <span>3D view</span>
      </button>
      )}
      </div>
      )}
    </div>
  );
}
