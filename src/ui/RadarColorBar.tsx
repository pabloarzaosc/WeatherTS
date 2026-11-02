import { useMemo, useState } from "react";

import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { usePaletteStore } from "../store/usePaletteStore";
import { useColorTableStore } from "../store/useColorTableStore";
import { activeTableId, resolveTableText, tableLabel } from "../lib/colorTables";
import { openEditor } from "../lib/colorTableInstall";
import { palNum } from "../lib/pal";
import { ColorTableEditor } from "./ColorTableEditor";
import { hcaKey } from "../lib/hca";
import { palGradient, palTicks, parsePal } from "../lib/pal";
import { useDragOffset } from "../lib/useDragOffset";
import { unitFor, unitTicks } from "../lib/radarUnits";
import type { PolarScan } from "../lib/radarMesh";
import type { DraggableId } from "../store/useLayoutStore";

// The Brazilian radars' ZDR products carry how much the backend moved the
// radar's ZDR (brazil_radar.py measures the calibration on each volume's light
// rain): dB added to the published ZDR, present only when it corrected it.
type ScanMeta = PolarScan["meta"] & { zdrOffsetDb?: number };

// The active palette, drawn along the bottom of the map with its data scale.
// This replaced the palette dropdown: the palette follows the product, so the
// useful thing on screen is what the colours *mean*, not a way to change them.

export function RadarColorBar({
  paneId,
  family: familyOverride,
  meta: metaOverride,
  dragId = "colorbar",
}: {
  paneId?: string;
  /** panes-compare: the scale of a pane's second (compared) product. */
  family?: string;
  meta?: PolarScan["meta"] | null;
  dragId?: DraggableId;
} = {}) {
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
  const drag = useDragOffset(dragId, { boundsSelector: ".mappane" });
  const catalog = useNexradStore((s) => s.catalog);
  const grids = useNexradStore((s) => s.grids);
  // A pane shows its OWN scale. Without paneId this is the focused pane, which
  // is what the single-pane layout wants.
  const globalFamily = useNexradStore((s) => s.family);
  const paneFamily = useNexradStore((s) => (paneId ? s.paneRadar[paneId]?.family : undefined));
  const family = familyOverride ?? paneFamily ?? globalFamily;
  // THIS pane's scan, for what only the loaded data knows (the ZDR correction).
  const storeMeta = useNexradStore((s) => (paneId ? s.paneRadar[paneId]?.scan : s.scan)?.meta) as
    | ScanMeta
    | undefined;
  const scanMeta = (familyOverride ? (metaOverride ?? undefined) : storeMeta) as ScanMeta | undefined;
  const palTables = useNexradStore((s) => s.palTables);
  const kindDefaults = useNexradStore((s) => s.kindDefaults);
  const overrides = usePaletteStore((s) => s.overrides);
  const custom = usePaletteStore((s) => s.custom);
  // colour-tables: the editor's live draft and the tables' scale/offset show
  // here too; the editor itself replaces this pane's bar while it is open.
  const adjust = usePaletteStore((s) => s.adjust);
  const draft = useColorTableStore((s) => s.draft);
  const editorPane = useColorTableStore((s) => s.editor?.paneId ?? null);
  const editorBase = useColorTableStore((s) => s.editor?.baseId ?? null);

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
    // The table the map draws with: chosen table, editor draft, scale/offset.
    const text = resolveTableText(pid, palTables);
    if (!text) return null;
    const id = activeTableId(pid, palTables);

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
      label: tableLabel(id, palTables),
      custom: id !== pid,
      pid,
      adj: adjust[id] ?? null,
      // Categories get a key of names, not a numbered ramp.
      key: fam.kind === "hca" ? hcaKey(table) : null,
    };
    // overrides/custom/draft/editorBase: resolveTableText reads them from the stores
  }, [fam, palTables, kindDefaults, overrides, custom, adjust, draft, editorBase]);

  // The chosen unit relabels the scale; the gradient underneath is untouched,
  // because the colours belong to the palette and the data, not to the words.
  const unit = unitFor(bar?.kind, radarUnits);
  // Only for the product on screen: a scan of the previous one says nothing here.
  const zdrFix =
    scanMeta && scanMeta.family === family && Number.isFinite(scanMeta.zdrOffsetDb)
      ? (scanMeta.zdrOffsetDb as number)
      : null;
  // Hovering the ramp reads the value of that colour (fraction 0..1 along it).
  const [hover, setHover] = useState<number | null>(null);

  // After the hooks, never before them.
  if (!radarOn || !site || !bar) return null;
  // The colour table editor docks here, in place of the pane's bar (the
  // compared product's bar steps aside while it is open).
  if (paneId && editorPane === paneId) {
    return familyOverride ? null : <ColorTableEditor paneId={paneId} productLabel={bar.product} />;
  }
  const span = bar.vmax - bar.vmin || 1;
  const pct = (v: number) => ((v - bar.vmin) / span) * 100;
  const hoverText = (() => {
    if (hover === null) return "";
    const v = bar.vmin + hover * span;
    if (unit) return `${(v * unit.factor).toFixed(unit.decimals)} ${unit.label}`;
    const dec = Math.abs(span) <= 2 ? 2 : Math.abs(span) <= 20 ? 1 : 0;
    return `${v.toFixed(dec)}${bar.units ? ` ${bar.units}` : ""}`;
  })();

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
        {zdrFix !== null && (
          <span
            className="cbar__units"
            title={
              `This radar's ZDR read ${Math.abs(zdrFix).toFixed(1)} dB ${zdrFix > 0 ? "low" : "high"} ` +
              "in this volume's light rain, and was corrected by that much before drawing."
            }
          >
            {`ZDR calibrated ${zdrFix > 0 ? "+" : ""}${zdrFix.toFixed(1)} dB`}
          </span>
        )}
        {bar.adj && (
          <span className="cbar__units" title="Colour scale and offset (right-click the map to change it)">
            ×{palNum(bar.adj.scale)} {bar.adj.offset >= 0 ? "+" : "−"}{palNum(Math.abs(bar.adj.offset))}
          </span>
        )}
        {bar.custom && <span className="cbar__badge" title={`Colour table: ${bar.label}`}>{bar.label}</span>}
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
          <div
            className="cbar__bar"
            style={{ background: `linear-gradient(to right, ${bar.gradient})` }}
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setHover(Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1))));
            }}
            onMouseLeave={() => setHover(null)}
            // The ramp is for reading; dragging the bar stays on its edges.
            onPointerDown={(e) => e.stopPropagation()}
            // ...and a click on it opens the colour table editor in this pane.
            onClick={() => {
              if (!fam || drag.dragging) return;
              const pane = paneId ?? null;
              if (pane) openEditor(pane, bar.pid, fam.kind);
            }}
            title="Click to edit this colour table"
          >
            {hover !== null && !drag.dragging && (
              <>
                <span className="cbar__hover-mark" style={{ left: `${hover * 100}%` }} />
                <span className="cbar__hover" style={{ left: `${Math.min(92, Math.max(8, hover * 100))}%` }}>
                  {hoverText}
                </span>
              </>
            )}
          </div>
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
