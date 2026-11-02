import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Download, Redo2, RotateCcw, Save, Undo2, X } from "lucide-react";

import { useAppStore } from "../store/useAppStore";
import { useColorTableStore } from "../store/useColorTableStore";
import { useNexradStore } from "../store/useNexradStore";
import { usePaletteStore } from "../store/usePaletteStore";
import { choicesFor, downloadText, exportHeader, KIND_UNIT_LABEL, palFileName, tableOf } from "../lib/colorTables";
import { openEditor, stepTable } from "../lib/colorTableInstall";
import { cloneEntries, colorAt, palGradient, palNum, palTicks, writePal, type PalEntry, type RGBA } from "../lib/pal";
import { unitFor } from "../lib/radarUnits";
import { Select } from "./Select";

// The colour table editor, docked along the bottom of a pane in place of its
// colour bar (click the bar to open it). Every edit is drawn at once on every
// pane showing the product -- the editor's table is the product's "draft"
// (useColorTableStore.draft, read by colorTables.resolveTableText) -- and is
// dropped when the editor closes unless saved.

const hex = (c: RGBA) => `#${[c.r, c.g, c.b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (h: string, a: number): RGBA => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
  a,
});
const css = (c: RGBA) => `rgba(${c.r},${c.g},${c.b},${(c.a / 255).toFixed(3)})`;

/** The value step of a drag or an arrow press: half a dBZ on reflectivity,
 *  finer on the small ranges (ZDR, CC). */
function quantum(span: number): number {
  return span >= 50 ? 0.5 : span >= 10 ? 0.1 : span >= 2 ? 0.05 : 0.005;
}
const snap = (v: number, q: number) => Number((Math.round(v / q) * q).toFixed(4));

/** A stop as "hidden": its band transparent up to the next stop. */
const isHidden = (e: PalEntry) => e.c1.a === 0 && (e.c2 === null || e.c2.a === 0);

export function ColorTableEditor({ paneId, productLabel }: { paneId: string; productLabel: string }) {
  const ed = useColorTableStore((s) => s.editor);
  const tables = useNexradStore((s) => s.palTables);
  const kindDefaults = useNexradStore((s) => s.kindDefaults);
  // the saved list feeds the table menu
  usePaletteStore((s) => s.custom);
  const adj = usePaletteStore((s) => (ed ? s.adjust[ed.baseId] : undefined));
  const radarUnits = useAppStore((s) => s.radarUnits);
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  /** The bar's value range, held still while a marker is dragged. */
  const [frozen, setFrozen] = useState<{ vmin: number; vmax: number } | null>(null);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  /** The value field's text while it is being typed in. */
  const [valueText, setValueText] = useState<string | null>(null);
  /** One undo step per colour-picker / alpha gesture, not one per change. */
  const gesture = useRef(false);
  /** A hidden stop's colours, to bring back on unhide. */
  const hiddenMemo = useRef(new Map<string, { c1: RGBA; c2: RGBA | null }>());

  // Live: the draft follows every edit (the recolour itself is coalesced to
  // one per frame by colorTableInstall).
  const entries = ed?.entries;
  const dirty = ed?.dirty;
  useEffect(() => {
    const cur = useColorTableStore.getState().editor;
    if (!cur) return;
    useColorTableStore
      .getState()
      .setDraft(cur.dirty ? { pid: cur.pid, text: writePal(cur.entries, exportHeader(cur.kind, cur.header)) } : null);
  }, [entries, dirty]);

  // Keys work as soon as it opens, and again after a table switch.
  const baseId = ed?.baseId;
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, [baseId]);

  if (!ed || ed.paneId !== paneId) return null;
  const st = useColorTableStore.getState;
  const es = ed.entries;
  const lo = es[0].v;
  const hi = es[es.length - 1].v;
  const vmin = frozen?.vmin ?? lo;
  const vmax = frozen?.vmax ?? hi;
  const span = vmax - vmin || 1;
  const pct = (v: number) => ((v - vmin) / span) * 100;
  const q = quantum(Math.abs(hi - lo));
  const unitLabel = KIND_UNIT_LABEL[ed.kind] ?? ed.header.units ?? "";
  const display = unitFor(ed.kind, radarUnits);
  const sel = ed.sel !== null && ed.sel < es.length ? ed.sel : null;
  const cur = sel !== null ? es[sel] : null;
  const fmt = (v: number) => `${palNum(v)}${unitLabel ? ` ${unitLabel}` : ""}`;
  const alt = (v: number) => (display && Math.abs(display.factor - 1) > 1e-9 ? ` ≈ ${(v * display.factor).toFixed(display.decimals)} ${display.label}` : "");

  const commit = (next: PalEntry[], selAt: number | null, popup?: boolean) => {
    st().edit(next, { record: true, sel: selAt });
    if (popup !== undefined) st().select(selAt, popup);
  };

  /** A stop where the bar was clicked, in the colour already there -- the
   *  picture does not change until the stop is edited. */
  const addAt = (v: number) => {
    const next = cloneEntries(es);
    const same = next.findIndex((e) => Math.abs(e.v - v) < q / 2);
    if (same >= 0) {
      st().select(same, true);
      return;
    }
    const i = next.findIndex((e, k) => e.v <= v && (k === next.length - 1 || next[k + 1].v > v));
    if (i < 0) return;
    const e = next[i];
    const col = colorAt(tableOf(next), v);
    const added: PalEntry = e.solid
      ? { v, c1: { ...e.c1 }, c2: null, solid: true }
      : { v, c1: col, c2: e.c2 ? { ...e.c2 } : null, solid: false };
    // The stop before now ramps to the new one's colour -- the same colour
    // it reached at this value before.
    if (!e.solid) e.c2 = null;
    next.splice(i + 1, 0, added);
    commit(next, i + 1, true);
  };

  const removeAt = (i: number) => {
    if (es.length <= 2) {
      setMsg("A table needs at least two stops.");
      return;
    }
    const next = cloneEntries(es);
    next.splice(i, 1);
    commit(next, Math.min(i, next.length - 1), false);
  };

  const patch = (i: number, f: (e: PalEntry) => void, record: boolean) => {
    const next = cloneEntries(es);
    f(next[i]);
    st().edit(next, { record });
  };

  /** Move a stop to a value, keeping the stops in order. */
  const moveTo = (i: number, v: number, record: boolean) => {
    const next = cloneEntries(es);
    const moved = next[i];
    moved.v = v;
    next.sort((a, b) => a.v - b.v);
    st().edit(next, { record, sel: next.indexOf(moved) });
  };

  const onBarDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const r = barRef.current?.getBoundingClientRect();
    if (!r) return;
    rootRef.current?.focus({ preventScroll: true });
    addAt(snap(vmin + ((e.clientX - r.left) / (r.width || 1)) * span, q));
  };

  const onStopDown = (i: number, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    const r = barRef.current?.getBoundingClientRect();
    if (!r) return;
    const wasOpen = ed.sel === i && ed.popup;
    st().select(i, wasOpen);
    const range = { vmin: lo, vmax: hi };
    const x0 = e.clientX;
    let moved = false;
    let at = i;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      if (!moved) {
        moved = true;
        setFrozen(range);
        st().checkpoint();
      }
      const now = st().editor;
      if (!now) return;
      const list = now.entries;
      // Past the bar's ends a first or last stop widens the table.
      let v = snap(range.vmin + ((ev.clientX - r.left) / (r.width || 1)) * (range.vmax - range.vmin), q);
      const below = at > 0 ? list[at - 1].v : -Infinity;
      const above = at < list.length - 1 ? list[at + 1].v : Infinity;
      v = Math.min(above, Math.max(below, v));
      const next = cloneEntries(list);
      next[at].v = v;
      st().edit(next, { sel: at });
      at = Math.min(at, next.length - 1);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setFrozen(null);
      // A click (no drag) opens the stop's popup, a second one closes it.
      if (!moved) st().select(i, !wasOpen);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    const mod = e.ctrlKey || e.metaKey;
    if (inField) {
      if (e.key === "Escape") {
        (e.target as HTMLElement).blur();
        rootRef.current?.focus({ preventScroll: true });
        e.preventDefault();
      }
      // a field's own undo, arrows and Delete stay the field's
      e.stopPropagation();
      return;
    }
    if (mod && (e.key === "z" || e.key === "Z")) {
      if (e.shiftKey) st().redo();
      else st().undo();
    } else if (mod && (e.key === "y" || e.key === "Y")) {
      st().redo();
    } else if (mod) {
      return;
    } else if ((e.key === "Delete" || e.key === "Backspace") && sel !== null) {
      removeAt(sel);
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && sel !== null) {
      const step = q * (e.shiftKey ? 10 : 1) * (e.key === "ArrowLeft" ? -1 : 1);
      moveTo(sel, snap(es[sel].v + step, q), true);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Home" || e.key === "End") {
      const last = es.length - 1;
      const next =
        e.key === "Home" ? 0 : e.key === "End" ? last : sel === null ? 0 : Math.min(last, Math.max(0, sel + (e.key === "ArrowUp" ? 1 : -1)));
      st().select(next, ed.popup);
    } else if (e.key === "Enter" && sel !== null) {
      st().select(sel, !ed.popup);
    } else if (e.key === "Escape") {
      if (ed.naming) st().setNaming(false);
      else if (ed.popup) st().select(sel, false);
      else st().closeEditor();
    } else if (e.key === "]" || e.key === "[") {
      stepTable(e.key === "]" ? 1 : -1, paneId);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const textNow = (label: string) => writePal(es, exportHeader(ed.kind, ed.header, `${label} · ${productLabel} colour table from WeatherTS`));

  const save = () => {
    setMsg(null);
    if (ed.baseSource !== "custom") {
      setName(`${productLabel} (${ed.baseLabel})`);
      st().setNaming(true);
      return;
    }
    const r = usePaletteStore.getState().save({ id: ed.baseId, label: ed.baseLabel, pal: textNow(ed.baseLabel), pid: ed.pid });
    if (!r.ok) return setMsg(r.error);
    usePaletteStore.getState().select(ed.pid, r.id);
    openEditor(paneId, ed.pid, ed.kind, r.id);
    st().showNote(`Saved “${ed.baseLabel}”`);
  };

  const saveAs = () => {
    const label = name.trim();
    if (!label) return setMsg("Give the palette a name.");
    const r = usePaletteStore.getState().save({ label, pal: textNow(label), pid: ed.pid });
    if (!r.ok) return setMsg(r.error);
    usePaletteStore.getState().select(ed.pid, r.id);
    openEditor(paneId, ed.pid, ed.kind, r.id);
    st().showNote(`Saved “${label}” for ${productLabel}`);
  };

  const choices = choicesFor(ed.pid, tables, kindDefaults);
  const options = choices.map((c) => ({
    value: c.id,
    label: c.source === "default" ? "Default" : c.label,
    hint: c.source === "default" ? c.label : undefined,
    group: c.source === "custom" ? "Saved" : "Built-in",
  }));
  const ticks = palTicks(vmin, vmax, ed.header.step);

  return (
    <div
      ref={rootRef}
      className="cted"
      role="listbox"
      aria-label={`${productLabel} colour table: ${es.length} stops`}
      aria-activedescendant={sel !== null ? `cted-${paneId}-${sel}` : undefined}
      tabIndex={0}
      onKeyDown={onKey}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="cted__head">
        <span className="cted__product">{productLabel}</span>
        <Select
          className="cted__table"
          value={ed.baseId}
          options={options}
          aria-label="Colour table"
          popWidth={220}
          onChange={(id) => {
            const c = choices.find((x) => x.id === id);
            if (!c) return;
            usePaletteStore.getState().select(ed.pid, c.source === "default" ? null : c.id);
            openEditor(paneId, ed.pid, ed.kind, c.id);
            setMsg(null);
          }}
        />
        {ed.dirty && <span className="cted__dirty">edited</span>}
        {adj && (
          <span className="cted__adj" title="This table's colour scale and offset (right-click the map to change it)">
            ×{palNum(adj.scale)} {adj.offset >= 0 ? "+" : "−"}{palNum(Math.abs(adj.offset))}
          </span>
        )}
        <span className="cted__grow" />
        {ed.naming ? (
          <span className="cted__naming">
            <input
              className="cted__name"
              value={name}
              autoFocus
              maxLength={60}
              aria-label="Name for the new palette"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveAs();
              }}
            />
            <button type="button" className="cted__btn cted__btn--main" onClick={saveAs}>
              Save
            </button>
            <button type="button" className="cted__btn" onClick={() => st().setNaming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <span className="cted__tools">
            <button type="button" className="cted__icon" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!ed.undo.length} onClick={() => st().undo()}>
              <Undo2 size={14} />
            </button>
            <button type="button" className="cted__icon" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!ed.redo.length} onClick={() => st().redo()}>
              <Redo2 size={14} />
            </button>
            <button type="button" className="cted__icon" title={`Back to “${ed.baseLabel}” as saved`} aria-label="Reset" disabled={!ed.dirty} onClick={() => st().reset()}>
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              className="cted__btn cted__btn--main"
              disabled={!ed.dirty && ed.baseSource === "custom"}
              title={ed.baseSource === "custom" ? `Save over “${ed.baseLabel}”` : "Built-in tables are kept as they are: save a copy"}
              onClick={save}
            >
              <Save size={13} /> Save
            </button>
            <button
              type="button"
              className="cted__btn"
              onClick={() => {
                setName(`${ed.baseLabel} copy`);
                st().setNaming(true);
              }}
            >
              Save as
            </button>
            <button
              type="button"
              className="cted__btn"
              title="Download this table as a .pal file (GR format)"
              onClick={() => downloadText(palFileName(ed.baseLabel + (ed.dirty ? " edited" : "")), textNow(ed.baseLabel))}
            >
              <Download size={13} /> .pal
            </button>
            <button
              type="button"
              className="cted__icon"
              title={ed.dirty ? "Close (unsaved changes are dropped)" : "Close"}
              aria-label="Close the colour table editor"
              onClick={() => st().closeEditor()}
            >
              <X size={15} />
            </button>
          </span>
        )}
      </div>

      <div className="cted__lane">
        {es.map((e, i) => (
          <button
            key={i}
            id={`cted-${paneId}-${i}`}
            type="button"
            role="option"
            aria-selected={i === sel}
            tabIndex={-1}
            className={`cted__stop${i === sel ? " is-sel" : ""}${isHidden(e) ? " is-hidden" : ""}`}
            style={{ left: `${Math.min(100, Math.max(0, pct(e.v)))}%` }}
            title={`${fmt(e.v)}${alt(e.v)} · drag to move, click for its colour`}
            onPointerDown={(ev) => onStopDown(i, ev)}
          >
            <i style={{ background: css(e.c1) }} />
          </button>
        ))}
        {cur && ed.popup && sel !== null && (
          <StopPopup
            key={sel}
            e={cur}
            left={Math.min(86, Math.max(14, pct(cur.v)))}
            title={`Stop at ${fmt(cur.v)}${alt(cur.v)}`}
            unitLabel={unitLabel}
            q={q}
            canRemove={es.length > 2}
            valueText={valueText}
            setValueText={setValueText}
            onColour={(h, which) => {
              patch(sel, (x) => {
                if (which === 1) x.c1 = fromHex(h, x.c1.a || 255);
                else if (x.c2) x.c2 = fromHex(h, x.c2.a || 255);
              }, !gesture.current);
              gesture.current = true;
            }}
            onAlpha={(a) => {
              patch(sel, (x) => {
                x.c1 = { ...x.c1, a };
                if (x.c2) x.c2 = { ...x.c2, a };
              }, !gesture.current);
              gesture.current = true;
            }}
            endGesture={() => {
              gesture.current = false;
            }}
            onValue={(v) => moveTo(sel, snap(v, q / 10), true)}
            onHide={(hide) => {
              const key = palNum(cur.v);
              patch(sel, (x) => {
                if (hide) {
                  hiddenMemo.current.set(key, { c1: { ...x.c1 }, c2: x.c2 ? { ...x.c2 } : null });
                  x.c1 = { ...x.c1, a: 0 };
                  x.c2 = x.solid ? null : { ...x.c1, a: 0 };
                } else {
                  const was = hiddenMemo.current.get(key);
                  x.c1 = was ? was.c1 : { ...x.c1, a: 255 };
                  x.c2 = was ? was.c2 : null;
                  if (x.c1.a === 0) x.c1 = { ...x.c1, a: 255 };
                }
              }, true);
            }}
            onRemove={() => removeAt(sel)}
            onClose={() => st().select(sel, false)}
          />
        )}
      </div>

      <div ref={barRef} className="cted__bar" onPointerDown={onBarDown} title="Click to add a stop here">
        <div
          className="cted__ramp"
          style={{
            left: `${pct(lo)}%`,
            width: `${((hi - lo) / span) * 100}%`,
            background: `linear-gradient(to right, ${palGradient(tableOf(es))})`,
          }}
        />
      </div>
      <div className="cted__ticks">
        {ticks.map((v) => (
          <span key={v} className="cted__tick" style={{ left: `${pct(v)}%` }}>
            {palNum(v)}
          </span>
        ))}
        {unitLabel && <span className="cted__unit">{unitLabel}</span>}
      </div>
      <div className="cted__foot">
        {msg ?? (
          <>
            {es.length} stops · click the bar to add one · drag a marker · ←/→ move · ↑/↓ pick · Delete removes · Ctrl+Z undoes ·
            {" "}
            <kbd>[</kbd> <kbd>]</kbd> switch tables
          </>
        )}
      </div>
    </div>
  );
}

function StopPopup(props: {
  e: PalEntry;
  left: number;
  title: string;
  unitLabel: string;
  q: number;
  canRemove: boolean;
  valueText: string | null;
  setValueText: (t: string | null) => void;
  onColour: (hex: string, which: 1 | 2) => void;
  onAlpha: (a: number) => void;
  endGesture: () => void;
  onValue: (v: number) => void;
  onHide: (hide: boolean) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { e, valueText, setValueText } = props;
  const hidden = isHidden(e);
  const commitValue = () => {
    if (valueText === null) return;
    const v = Number(valueText.replace(",", "."));
    setValueText(null);
    if (Number.isFinite(v) && v !== e.v) props.onValue(v);
  };
  return (
    // kept whole inside the editor (and so the pane): a narrow pane's end
    // stops would otherwise push half the popup past the pane's edge
    <div className="cted__pop" style={{ left: `clamp(116px, ${props.left}%, calc(100% - 116px))` }} role="dialog" aria-label={props.title}>
      <div className="cted__pophead">
        <span>{props.title}</span>
        <button type="button" className="cted__icon" aria-label="Close" onClick={props.onClose}>
          <X size={13} />
        </button>
      </div>
      <label className="cted__row">
        <span>Colour</span>
        <input
          type="color"
          value={hex(e.c1)}
          onChange={(ev) => props.onColour(ev.target.value, 1)}
          onBlur={props.endGesture}
        />
        <code>{hex(e.c1)}</code>
      </label>
      {e.c2 && !e.solid && (
        <label className="cted__row" title="This stop's band ramps to its own end colour (a hard break at the next stop)">
          <span>Ends at</span>
          <input type="color" value={hex(e.c2)} onChange={(ev) => props.onColour(ev.target.value, 2)} onBlur={props.endGesture} />
          <code>{hex(e.c2)}</code>
        </label>
      )}
      <label className="cted__row">
        <span>Value</span>
        <input
          className="cted__num"
          type="number"
          step={props.q}
          value={valueText ?? palNum(e.v)}
          onChange={(ev) => setValueText(ev.target.value)}
          onBlur={commitValue}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") commitValue();
          }}
        />
        <em>{props.unitLabel}</em>
      </label>
      <label className="cted__row">
        <span>Alpha</span>
        <input
          type="range"
          min={0}
          max={255}
          step={1}
          value={e.c1.a}
          disabled={hidden}
          onChange={(ev) => props.onAlpha(Number(ev.target.value))}
          onPointerUp={props.endGesture}
          onBlur={props.endGesture}
        />
        <em>{Math.round((e.c1.a / 255) * 100)}%</em>
      </label>
      <div className="cted__row cted__row--acts">
        <label className="cted__check">
          <input type="checkbox" checked={hidden} onChange={(ev) => props.onHide(ev.target.checked)} />
          Hide
        </label>
        <button type="button" className="cted__btn cted__btn--danger" disabled={!props.canRemove} onClick={props.onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}
