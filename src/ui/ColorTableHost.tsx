import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Palette, Upload, X } from "lucide-react";

import { useColorTableStore, type ImportItem } from "../store/useColorTableStore";
import { useNexradStore } from "../store/useNexradStore";
import { MAX_CUSTOM, usePaletteStore } from "../store/usePaletteStore";
import { useAppStore } from "../store/useAppStore";
import {
  activeTableId,
  collectDrop,
  commitImport,
  exportHeader,
  fixedText,
  repickItem,
  startImport,
  tableLabel,
  tableText,
} from "../lib/colorTables";
import { paneProduct } from "../lib/colorTableInstall";
import { moveEntries, palGradient, palNum, parsePal, writePal } from "../lib/pal";
import { Select } from "./Select";

// Everything about colour tables that is not docked in a pane: the bulk .pal
// import (drop files or a folder anywhere on the window), the colour scale and
// offset dialog (right-click the map), and the short note ] / [ leave.

/** Files picked or dropped: sorted, then shown in the import dialog. */
export async function importPalFiles(files: File[], skipped = 0): Promise<void> {
  const ct = useColorTableStore.getState();
  if (!files.length) {
    ct.showNote(skipped ? `No .pal colour tables in that (${skipped} other file${skipped === 1 ? "" : "s"})` : "Nothing to import");
    return;
  }
  const nx = useNexradStore.getState();
  if (!Object.keys(nx.kindDefaults).length) await nx.loadCatalog().catch(() => undefined);
  await startImport(files, skipped, useNexradStore.getState().kindDefaults);
}

/** A drop's .pal files (folders walked). Must be called inside the drop event. */
export function importDrop(dt: DataTransfer): void {
  const got = collectDrop(dt);
  void got.then(({ files, skipped }) => importPalFiles(files, skipped));
}

export function ColorTableHost() {
  return (
    <>
      <DropCatcher />
      <ImportDialog />
      <ScaleDialog />
      <TableNote />
    </>
  );
}

// ---------------------------------------------------------------------------

function DropCatcher() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const files = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!files(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    // Without this a file dropped on the window replaced the whole app with it.
    const dragover = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      depth = 0;
      setOver(false);
      if (e.defaultPrevented) return; // a drop zone took it
      e.preventDefault();
      if (e.dataTransfer) importDrop(e.dataTransfer);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", dragover);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", dragover);
      window.removeEventListener("drop", drop);
    };
  }, []);
  if (!over) return null;
  return (
    <div className="ctab-drop" aria-hidden>
      <div className="ctab-drop__card">
        <Upload size={18} />
        Drop .pal colour tables (or a folder of them) to import
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const GROUPS: { id: ImportItem["group"]; title: string; note: string }[] = [
  { id: "check", title: "Check these", note: "sorted, but something looks off" },
  { id: "pick", title: "Pick a product", note: "nothing says what these colour" },
  { id: "sorted", title: "Sorted", note: "" },
  { id: "bad", title: "Can't import", note: "" },
];

function ImportDialog() {
  const im = useColorTableStore((s) => s.importer);
  const products = useNexradStore((s) => s.palettes);
  const kindDefaults = useNexradStore((s) => s.kindDefaults);
  const saved = usePaletteStore((s) => s.custom.length);
  const ct = useColorTableStore.getState;

  useEffect(() => {
    if (!im) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") ct().closeImport();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [im, ct]);

  if (!im) return null;
  const ticked = im.items.filter((it) => it.checked && it.pid && !it.error).length;
  const over = saved + ticked - MAX_CUSTOM;
  const options = [
    { value: "", label: "Pick a product…" },
    ...products.map((p) => ({ value: p.id, label: p.label })),
  ];
  const labelOf = (pid: string | null) => products.find((p) => p.id === pid)?.label ?? pid ?? "";

  return (
    <div className="ctab-modal" role="presentation" onPointerDown={(e) => e.target === e.currentTarget && ct().closeImport()}>
      <div className="ctab-imp" role="dialog" aria-label="Import colour tables">
        <div className="ctab-imp__head">
          <Palette size={16} />
          <span className="ctab-imp__title">Import colour tables</span>
          <span className="ctab-imp__count">
            {im.items.length} file{im.items.length === 1 ? "" : "s"}
            {im.skipped ? ` · ${im.skipped} other file${im.skipped === 1 ? "" : "s"} skipped` : ""}
          </span>
          <button type="button" className="cted__icon" aria-label="Close" onClick={() => ct().closeImport()}>
            <X size={15} />
          </button>
        </div>
        <div className="ctab-imp__body">
          {GROUPS.map((g) => {
            const rows = im.items.filter((it) => it.group === g.id);
            if (!rows.length) return null;
            return (
              <section key={g.id} className={`ctab-imp__group ctab-imp__group--${g.id}`}>
                <h4>
                  {g.title} <span>{rows.length}</span>
                  {g.note && <em>{g.note}</em>}
                </h4>
                {rows.map((it) => (
                  <ImportRow key={it.key} it={it} options={options} productLabel={labelOf(it.pid)} kindDefaults={kindDefaults} />
                ))}
              </section>
            );
          })}
        </div>
        <div className="ctab-imp__foot">
          <label className="cted__check" title="Draw each product with the first table imported for it">
            <input type="checkbox" checked={im.switchTo} onChange={(e) => ct().setImport({ switchTo: e.target.checked })} />
            Switch to them
          </label>
          <span className="ctab-imp__room">
            {im.error ? (
              <span className="ctab-imp__err">{im.error}</span>
            ) : over > 0 ? (
              <span className="ctab-imp__err">
                Up to {MAX_CUSTOM} saved palettes: untick {over}, or remove some in Settings › Palettes
              </span>
            ) : (
              `${saved} of ${MAX_CUSTOM} saved`
            )}
          </span>
          <button type="button" className="cted__btn" onClick={() => ct().closeImport()}>
            Cancel
          </button>
          <button type="button" className="cted__btn cted__btn--main" disabled={!ticked || over > 0} onClick={() => commitImport()}>
            Import {ticked || ""}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportRow({
  it,
  options,
  productLabel,
  kindDefaults,
}: {
  it: ImportItem;
  options: { value: string; label: string }[];
  productLabel: string;
  kindDefaults: Record<string, string>;
}) {
  const ct = useColorTableStore.getState;
  const table = it.error ? null : parsePal(it.text);
  const strip = table && table.entries.length > 1 ? palGradient(table) : "";
  const range = table && table.entries.length > 1 ? `${palNum(table.entries[0].v)} – ${palNum(table.entries[table.entries.length - 1].v)}` : "";
  return (
    <div className={`ctab-row${it.checked ? "" : " is-off"}`}>
      <input
        type="checkbox"
        aria-label={`Import ${it.name}`}
        checked={it.checked}
        disabled={!!it.error || !it.pid}
        onChange={(e) => ct().updateItem(it.key, { checked: e.target.checked })}
      />
      <div className="ctab-row__main">
        <div className="ctab-row__top">
          <span className="ctab-row__name" title={it.name}>
            {it.name}
          </span>
          {!it.error && (
            <Select
              className="ctab-row__prod"
              value={it.pid ?? ""}
              options={options}
              aria-label={`Product for ${it.name}`}
              popWidth={220}
              onChange={(v) => ct().updateItem(it.key, repickItem(it, v || null, kindDefaults))}
            />
          )}
        </div>
        {strip && (
          <div className="ctab-row__strip" style={{ background: `linear-gradient(to right, ${strip})` }} title={`${productLabel}: ${range}`}>
            <span>{range}</span>
          </div>
        )}
        <div className="ctab-row__meta">
          {it.error ? (
            <span className="ctab-row__err">{it.error}</span>
          ) : (
            <>
              {it.hint && <span>{it.hint}</span>}
              {it.dup && <span className="ctab-row__dup">same stops as {it.dup}: left unticked</span>}
            </>
          )}
        </div>
        {it.warnings.map((w) => (
          <div key={w} className="ctab-row__warn">
            <AlertTriangle size={12} />
            <span>{w}</span>
          </div>
        ))}
        {it.fix && (
          <div className="ctab-row__fix">
            {it.fixed ? (
              <span className="ctab-row__ok">
                Stops converted from {it.fix.from} to {it.fix.to} ({it.fix.label})
              </span>
            ) : (
              <button
                type="button"
                className="cted__btn"
                onClick={() =>
                  ct().updateItem(it.key, {
                    text: fixedText(it, kindDefaults),
                    fixed: true,
                    warnings: it.warnings.filter((w) => !w.includes("Fix Scale")),
                  })
                }
              >
                Fix Scale {it.fix.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Right-click › Color Scale and Offset, for the pane's product. */
export function ColorScaleMenuItem({ paneId, x, y, onDone }: { paneId: string | null; x: number; y: number; onDone: () => void }) {
  const radarOn = useAppStore((s) => s.layers.nexrad?.visible ?? false);
  const site = useNexradStore((s) => s.site);
  const p = paneProduct(paneId);
  if (!radarOn || !site || !p || p.kind === "hca") return null;
  return (
    <button
      type="button"
      className="mapmenu__item"
      onClick={() => {
        const tables = useNexradStore.getState().palTables;
        useColorTableStore.getState().openScale({ paneId, pid: p.pid, kind: p.kind, tableId: activeTableId(p.pid, tables), x, y });
        onDone();
      }}
      title="Stretch or shift this product's colour table"
    >
      <Palette size={15} />
      Color Scale and Offset
      <span className="mapmenu__hint ctab-menuhint">{p.label}</span>
    </button>
  );
}

const SCALE_MIN = 0.25;
const SCALE_MAX = 4;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function ScaleDialog() {
  const d = useColorTableStore((s) => s.scale);
  const tables = useNexradStore((s) => s.palTables);
  const adj = usePaletteStore((s) => (d ? s.adjust[d.tableId] : undefined));
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [fields, setFields] = useState<{ s: string | null; o: string | null }>({ s: null, o: null });
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!d) return;
    setErr(null);
    setFields({ s: null, o: null });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useColorTableStore.getState().closeScale();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [d]);

  if (!d) return null;
  const text = tableText(d.tableId, tables);
  if (!text) return null;
  const t = parsePal(text);
  if (t.entries.length < 2) return null;
  const lo = t.entries[0].v;
  const hi = t.entries[t.entries.length - 1].v;
  const span = Math.abs(hi - lo) || 1;
  const offMax = Math.max(1, Math.ceil(span / 2 / 5) * 5);
  const q = span >= 50 ? 0.5 : span >= 10 ? 0.1 : span >= 2 ? 0.05 : 0.005;
  const scale = adj?.scale ?? 1;
  const offset = adj?.offset ?? 0;
  const label = tableLabel(d.tableId, tables);
  const p = paneProduct(d.paneId);
  const productLabel = p?.pid === d.pid ? p.label : label;
  const setAdj = (s: number, o: number) =>
    usePaletteStore.getState().setAdjust(d.tableId, { scale: Number(clamp(s, SCALE_MIN, SCALE_MAX).toFixed(3)), offset: Number(clamp(o, -offMax, offMax).toFixed(3)) });
  const moved = moveEntries(t.entries, scale, offset);
  const preview = palGradient({ ...t, entries: moved });
  const left = clamp(d.x, 8, window.innerWidth - 330);
  const top = clamp(d.y, 8, window.innerHeight - 330);

  const saveAs = () => {
    const l = name.trim();
    if (!l) return setErr("Give the palette a name.");
    const pal = writePal(
      moved,
      exportHeader(d.kind, { product: t.product, units: t.units, step: scale === 1 ? t.step : null, rf: t.rf }, `${l} · ${label} ×${palNum(scale)} ${offset >= 0 ? "+" : "-"}${palNum(Math.abs(offset))}`),
    );
    const r = usePaletteStore.getState().save({ label: l, pal, pid: d.pid });
    if (!r.ok) return setErr(r.error);
    usePaletteStore.getState().select(d.pid, r.id);
    usePaletteStore.getState().setAdjust(d.tableId, null);
    useColorTableStore.getState().closeScale();
    useColorTableStore.getState().showNote(`Saved “${l}” for ${productLabel}`);
  };

  return (
    <div ref={box} className="ctab-scale" role="dialog" aria-label="Color scale and offset" style={{ left, top }}>
      <div className="ctab-imp__head">
        <Palette size={15} />
        <span className="ctab-imp__title">Color scale and offset</span>
        <button type="button" className="cted__icon" aria-label="Close" onClick={() => useColorTableStore.getState().closeScale()}>
          <X size={15} />
        </button>
      </div>
      <div className="ctab-scale__sub">
        {productLabel} · {d.tableId === d.pid ? "Default" : label}
      </div>
      <label className="ctab-scale__row">
        <span>Scale</span>
        <input
          type="range"
          min={-100}
          max={100}
          step={1}
          value={Math.round(Math.log2(scale) * 50)}
          onChange={(e) => setAdj(Math.pow(2, Number(e.target.value) / 50), offset)}
          aria-label="Scale"
        />
        <input
          className="cted__num"
          type="number"
          min={SCALE_MIN}
          max={SCALE_MAX}
          step={0.01}
          value={fields.s ?? palNum(scale)}
          onChange={(e) => setFields({ ...fields, s: e.target.value })}
          onBlur={() => {
            const v = Number((fields.s ?? "").replace(",", "."));
            if (fields.s !== null && Number.isFinite(v) && v > 0) setAdj(v, offset);
            setFields({ ...fields, s: null });
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </label>
      <label className="ctab-scale__row">
        <span>Offset</span>
        <input
          type="range"
          min={-offMax}
          max={offMax}
          step={q}
          value={offset}
          onChange={(e) => setAdj(scale, Number(e.target.value))}
          aria-label="Offset"
        />
        <input
          className="cted__num"
          type="number"
          step={q}
          value={fields.o ?? palNum(offset)}
          onChange={(e) => setFields({ ...fields, o: e.target.value })}
          onBlur={() => {
            const v = Number((fields.o ?? "").replace(",", "."));
            if (fields.o !== null && Number.isFinite(v)) setAdj(scale, v);
            setFields({ ...fields, o: null });
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </label>
      <div className="ctab-scale__strip" style={{ background: `linear-gradient(to right, ${preview})` }} />
      <div className="ctab-scale__range">
        <span>{palNum(moved[0].v)}</span>
        <span>{palNum(moved[moved.length - 1].v)}</span>
      </div>
      <p className="ctab-scale__hint">
        Each colour moves from v to v × scale + offset; the map and its colour bar change as you go, and the readout keeps
        reading the data. It stays with this table until reset.
      </p>
      {d.naming ? (
        <div className="ctab-scale__acts">
          <input
            className="cted__name"
            value={name}
            autoFocus
            maxLength={60}
            aria-label="Name for the new palette"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveAs()}
          />
          <button type="button" className="cted__btn cted__btn--main" onClick={saveAs}>
            Save
          </button>
          <button type="button" className="cted__btn" onClick={() => useColorTableStore.getState().setScaleNaming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="ctab-scale__acts">
          <button type="button" className="cted__btn" disabled={scale === 1 && offset === 0} onClick={() => usePaletteStore.getState().setAdjust(d.tableId, null)}>
            Reset
          </button>
          <span className="cted__grow" />
          <button
            type="button"
            className="cted__btn"
            disabled={scale === 1 && offset === 0}
            onClick={() => {
              setName(`${label} ×${palNum(scale)}${offset ? ` ${offset > 0 ? "+" : "-"}${palNum(Math.abs(offset))}` : ""}`);
              useColorTableStore.getState().setScaleNaming(true);
            }}
          >
            Save as palette
          </button>
          <button type="button" className="cted__btn cted__btn--main" onClick={() => useColorTableStore.getState().closeScale()}>
            Done
          </button>
        </div>
      )}
      {err && <div className="ctab-imp__err">{err}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TableNote() {
  const note = useColorTableStore((s) => s.note);
  const [shown, setShown] = useState<{ text: string; id: number } | null>(null);
  useEffect(() => {
    if (!note) return;
    setShown(note);
    const t = window.setTimeout(() => setShown((s) => (s?.id === note.id ? null : s)), 1800);
    return () => window.clearTimeout(t);
  }, [note]);
  if (!shown) return null;
  return (
    <div className="ctab-note" role="status" key={shown.id}>
      <Palette size={14} />
      {shown.text}
    </div>
  );
}
