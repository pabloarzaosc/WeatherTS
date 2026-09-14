import { useMemo } from "react";

import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { usePaletteStore } from "../store/usePaletteStore";
import { hcaKey } from "../lib/hca";
import { palGradient, palTicks, parsePal } from "../lib/pal";
import { useDragOffset } from "../lib/useDragOffset";
import { unitFor, unitTicks } from "../lib/radarUnits";

// The active palette, drawn along the bottom of the map with its data scale.
// This replaced the palette dropdown: the palette follows the product, so the
// useful thing on screen is what the colours *mean*, not a way to change them.

export function RadarColorBar({ paneId }: { paneId?: string } = {}) {
  // A scale for a layer that isn't drawn describes nothing: the product stays
  // selected in the store when the radar layer is switched off, so without this
  // the bar sat over an empty map.
  const radarOn = useAppStore((s) => s.layers.nexrad?.visible ?? false);
  const radarUnits = useAppStore((s) => s.radarUnits);
  // ...and a scale for a site nobody has picked describes nothing either. The
  // product family carries a default, so without this the bar appeared the
  // instant the layer was switched on, over a map with no scan on it at all.
  const site = useNexradStore((s) => s.site);
  // One offset shared by every pane's bar: the panes are equal cells, so a
  // per-pane position would drift them out of alignment for no benefit.
  // Bounded by the pane, which clips its children -- dragged past the edge the
  // bar would simply vanish rather than go off screen.
  const drag = useDragOffset("colorbar", { boundsSelector: ".mappane" });
  const catalog = useNexradStore((s) => s.catalog);
  const grids = useNexradStore((s) => s.grids);
  // A pane shows its OWN scale. Without paneId this is the focused pane, which
  // is what the single-pane layout wants.
  const globalFamily = useNexradStore((s) => s.family);
  const paneFamily = useNexradStore((s) => (paneId ? s.paneRadar[paneId]?.family : undefined));
  const family = paneFamily ?? globalFamily;
  const palTables = useNexradStore((s) => s.palTables);
  const kindDefaults = useNexradStore((s) => s.kindDefaults);
  const overrides = usePaletteStore((s) => s.overrides);
  const custom = usePaletteStore((s) => s.custom);

  // Driven by the selected product, not the loaded scan: the scale is known
  // before the data lands, so switching tilt doesn't blink the bar away.
  // `grids` is the merged list (every product, best source); `catalog` is the
  // legacy Level III-only fallback for anything not in it.
  const fam =
    grids.find((f) => f.id === family) ??
    catalog.find((f) => f.id === family);

  const bar = useMemo(() => {
    if (!fam) return null;
    const pid = kindDefaults[fam.kind] ?? "REF";
    const mine = overrides[pid] ? custom.find((p) => p.id === overrides[pid]) : null;
    const text = mine?.pal ?? palTables[pid]?.pal;
    if (!text) return null;

    const table = parsePal(text);
    if (table.entries.length < 2) return null;
    const vmin = table.entries[0].v;
    const vmax = table.entries[table.entries.length - 1].v;
    return {
      gradient: palGradient(table),
      vmin,
      vmax,
      ticks: palTicks(vmin, vmax, table.step),
      kind: fam.kind,
      units: fam.units || table.units || "",
      product: fam.label,
      label: mine?.label ?? palTables[pid]?.label ?? pid,
      custom: !!mine,
      // Categories get a key of names, not a numbered ramp.
      key: fam.kind === "hca" ? hcaKey(table) : null,
    };
  }, [fam, palTables, kindDefaults, overrides, custom]);

  // The chosen unit relabels the scale; the gradient underneath is untouched,
  // because the colours belong to the palette and the data, not to the words.
  const unit = unitFor(bar?.kind, radarUnits);

  // After the hooks, never before them.
  if (!radarOn || !site || !bar) return null;
  const span = bar.vmax - bar.vmin || 1;
  const pct = (v: number) => ((v - bar.vmin) / span) * 100;

  return (
    <div
      ref={drag.ref}
      className={`cbar hud-grip${drag.dragging ? " is-dragging" : ""}`}
      style={drag.style}
      aria-label={`Colour scale: ${bar.label}`}
      title="Drag to move"
      {...drag.handle}
    >
      <div className="cbar__head">
        <span className="cbar__product">{bar.product}</span>
        {(unit?.label ?? bar.units) && (
          <span className="cbar__units">{unit?.label ?? bar.units}</span>
        )}
        {bar.custom && <span className="cbar__badge">custom</span>}
      </div>
      {bar.key ? (
        <div className="cbar__key">
          {bar.key.map((c) => (
            <span key={c.code} className="cbar__class" title={`${c.label} (${c.short})`}>
              <i className="cbar__swatch" style={{ background: c.color }} />
              {c.label}
            </span>
          ))}
        </div>
      ) : (
        <>
          <div className="cbar__bar" style={{ background: `linear-gradient(to right, ${bar.gradient})` }} />
          <div className="cbar__ticks">
            {(unit ? unitTicks(unit, bar.vmin, bar.vmax) : bar.ticks.map((v) => ({ label: String(v), native: v }))).map(
              (t) => (
                <span key={t.label} className="cbar__tick" style={{ left: `${pct(t.native)}%` }}>
                  {t.label}
                </span>
              ),
            )}
          </div>
        </>
      )}
    </div>
  );
}
